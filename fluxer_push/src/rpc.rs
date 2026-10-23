// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::config::{RPC_AUTH_HEADER, RpcConfig};
use crate::metrics::{Metrics, RpcMethod, RpcOutcome, elapsed_ms};
use crate::subscription::Subscription;
use fluxer_common::secret::SecretString;
use fluxer_svc::metrics::now_ms;
use rand::RngExt as _;
use serde::Deserialize;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use tracing::warn;

const USER_BATCH_MAX: usize = 2_000;
const DELETION_BATCH_MAX: usize = 100;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ATTEMPTS: u32 = 3;
const BASE_BACKOFF_MS: u64 = 200;
const MAX_BACKOFF_MS: u64 = 2_000;
const JITTER_MS: u64 = 200;
const ERROR_MESSAGE_MAX: usize = 512;

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("internal rpc transport failed: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("internal rpc returned {code}: {message}")]
    Status { code: u16, message: String },
    #[error("internal rpc response could not be decoded: {0}")]
    Decode(#[from] serde_json::Error),
}

impl RpcError {
    pub(crate) fn is_retryable(&self) -> bool {
        match self {
            Self::Transport(_) => true,
            Self::Status { code, .. } => *code >= 500,
            Self::Decode(_) => false,
        }
    }
}

pub struct RpcClient {
    http: reqwest::Client,
    url: String,
    readonly_urls: Option<Vec<String>>,
    health: Arc<Mutex<Vec<(bool, u32, u32)>>>,
    auth: SecretString,
    metrics: Arc<Metrics>,
}

impl RpcClient {
    pub fn new(cfg: &RpcConfig, http: reqwest::Client, metrics: Arc<Metrics>) -> Self {
        let urls = cfg
            .readonly_urls
            .clone()
            .unwrap_or_else(|| vec![cfg.url.clone()]);
        let health = Arc::new(Mutex::new(vec![(true, 0, 0); urls.len()]));
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let weak = Arc::downgrade(&health);
            let probe = http.clone();
            runtime.spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    let Some(states) = weak.upgrade() else {
                        break;
                    };
                    for (i, url) in urls.iter().enumerate() {
                        let ready = format!("{}/_ready", url.trim_end_matches("/internal/rpc"));
                        let good = probe
                            .get(ready)
                            .timeout(Duration::from_secs(1))
                            .send()
                            .await
                            .is_ok_and(|r| r.status().is_success());
                        if let Ok(mut state) = states.lock() {
                            let (healthy, fail, pass) = state[i];
                            state[i] = if good {
                                (healthy || pass + 1 >= 2, 0, pass + 1)
                            } else {
                                (healthy && fail + 1 < 2, fail + 1, 0)
                            };
                        }
                    }
                }
            });
        }
        Self {
            http,
            health,
            url: cfg.url.clone(),
            readonly_urls: cfg.readonly_urls.clone(),
            auth: cfg.auth_token.clone(),
            metrics,
        }
    }

    pub async fn push_service_delivery_config(&self) -> Result<Value, RpcError> {
        let data: PushServiceDeliveryConfigData = self
            .call(
                RpcMethod::GetPushServiceDeliveryConfig,
                &json!({"type": "get_push_service_delivery_config"}),
            )
            .await?;
        Ok(data.config)
    }

    pub async fn badge_counts(
        &self,
        user_ids: &[String],
    ) -> Result<HashMap<String, u32>, RpcError> {
        let mut counts = HashMap::new();
        for batch in user_ids.chunks(USER_BATCH_MAX) {
            let data: BadgeCountsData = self
                .call(
                    RpcMethod::GetBadgeCounts,
                    &json!({"type": "get_badge_counts", "user_ids": batch}),
                )
                .await?;
            counts.extend(data.badge_counts);
        }
        Ok(counts)
    }

    pub async fn push_subscriptions(
        &self,
        user_ids: &[String],
    ) -> Result<HashMap<String, Vec<Subscription>>, RpcError> {
        let mut subscriptions = HashMap::new();
        for batch in user_ids.chunks(USER_BATCH_MAX) {
            let data: HashMap<String, Vec<Subscription>> = self
                .call(
                    RpcMethod::GetPushSubscriptions,
                    &json!({"type": "get_push_subscriptions", "user_ids": batch}),
                )
                .await?;
            subscriptions.extend(data);
        }
        Ok(subscriptions)
    }

    pub async fn delete_push_subscriptions(
        &self,
        subscriptions: &[(String, String)],
    ) -> Result<(), RpcError> {
        for batch in subscriptions.chunks(DELETION_BATCH_MAX) {
            let entries = batch
                .iter()
                .map(|(user_id, subscription_id)| {
                    json!({"user_id": user_id, "subscription_id": subscription_id})
                })
                .collect::<Vec<Value>>();
            self.call::<IgnoredAny>(
                RpcMethod::DeletePushSubscriptions,
                &json!({"type": "delete_push_subscriptions", "subscriptions": entries}),
            )
            .await?;
        }
        Ok(())
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: RpcMethod,
        body: &Value,
    ) -> Result<T, RpcError> {
        // Each logical read keeps its ID; safe retries may choose another healthy API.
        let routing_id = format!("{:032x}", rand::random::<u128>());
        let started = tokio::time::Instant::now();
        let readonly = readonly_type(body.get("type").and_then(Value::as_str).unwrap_or(""));
        let mut attempt = 1;
        loop {
            let Some(target) = self.healthy_target(body, &routing_id, attempt) else {
                return Err(RpcError::Status {
                    code: 503,
                    message: "no healthy API".to_owned(),
                });
            };
            let budget = REQUEST_TIMEOUT.saturating_sub(started.elapsed());
            if budget.is_zero() {
                return Err(RpcError::Status {
                    code: 503,
                    message: "RPC deadline exceeded".to_owned(),
                });
            }
            let error =
                match tokio::time::timeout(budget, self.attempt(method, body, &routing_id, target))
                    .await
                {
                    Err(_) => {
                        return Err(RpcError::Status {
                            code: 503,
                            message: "RPC outcome unknown after timeout".to_owned(),
                        });
                    }
                    Ok(Ok(data)) => return Ok(data),
                    Ok(Err(error)) => error,
                };
            if !readonly || !error.is_retryable() || attempt >= MAX_ATTEMPTS {
                return Err(error);
            }
            let delay_ms = backoff_delay_ms(attempt);
            warn!(
                method = method.label(),
                attempt,
                max_attempts = MAX_ATTEMPTS,
                delay_ms,
                error = %error,
                "internal rpc retrying"
            );
            tokio::time::sleep(
                Duration::from_millis(delay_ms)
                    .min(REQUEST_TIMEOUT.saturating_sub(started.elapsed())),
            )
            .await;
            attempt += 1;
        }
    }

    async fn attempt<T: DeserializeOwned>(
        &self,
        method: RpcMethod,
        body: &Value,
        routing_id: &str,
        target: &str,
    ) -> Result<T, RpcError> {
        let started_ms = now_ms();
        let result = self.request(body, routing_id, target).await;
        let duration_ms = elapsed_ms(started_ms);
        let outcome = if result.is_ok() {
            RpcOutcome::Ok
        } else {
            RpcOutcome::Error
        };
        self.metrics.record_rpc(method, outcome, duration_ms);
        result
    }

    fn healthy_target<'a>(&'a self, body: &Value, id: &str, attempt: u32) -> Option<&'a str> {
        let states = self.health.lock().ok()?;
        let choices: Vec<usize> = states
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.0.then_some(i))
            .collect();
        if choices.is_empty() {
            return None;
        }
        let readonly = readonly_type(body.get("type").and_then(Value::as_str).unwrap_or(""));
        let pick = if readonly {
            (fnv1a(id.as_bytes()) as usize + (attempt - 1) as usize) % choices.len()
        } else {
            0
        };
        let index = choices[pick];
        Some(
            self.readonly_urls
                .as_ref()
                .map_or(self.url.as_str(), |urls| urls[index].as_str()),
        )
    }

    async fn request<T: DeserializeOwned>(
        &self,
        body: &Value,
        routing_id: &str,
        target: &str,
    ) -> Result<T, RpcError> {
        let response = self
            .http
            .post(target)
            .header(RPC_AUTH_HEADER, self.auth.expose())
            .header(
                "x-fluxer-rpc-type",
                body.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
            )
            .header("x-fluxer-rpc-request-id", routing_id)
            .timeout(REQUEST_TIMEOUT)
            .json(body)
            .send()
            .await?;
        let code = response.status().as_u16();
        let payload = response.bytes().await?;
        if !(200..300).contains(&code) {
            return Err(RpcError::Status {
                code,
                message: error_message(&payload),
            });
        }
        let mut envelope: HashMap<String, Value> = serde_json::from_slice(&payload)?;
        let data = envelope.remove("data").unwrap_or_else(|| json!({}));
        Ok(serde_json::from_value(data)?)
    }
}

// FNV-1a 32 位，与 Erlang 相同，不依赖运行时默认散列。
fn fnv1a(bytes: &[u8]) -> u32 {
    bytes.iter().fold(2166136261u32, |h, c| {
        (h ^ u32::from(*c)).wrapping_mul(16777619)
    })
}
fn readonly_type(kind: &str) -> bool {
    matches!(
        kind,
        "get_read_state"
            | "get_user_guild_settings"
            | "get_user_blocked_ids"
            | "get_push_subscriptions"
            | "get_badge_counts"
            | "list_thread_members"
            | "forum_unreads"
    )
}

#[derive(Deserialize)]
struct PushServiceDeliveryConfigData {
    config: Value,
}

#[derive(Deserialize)]
struct BadgeCountsData {
    #[serde(default)]
    badge_counts: HashMap<String, u32>,
}

fn backoff_delay_ms(attempt: u32) -> u64 {
    let exponential = BASE_BACKOFF_MS.saturating_mul(1u64 << (attempt - 1).min(16));
    exponential.min(MAX_BACKOFF_MS) + rand::rng().random_range(0..JITTER_MS)
}

fn error_message(payload: &[u8]) -> String {
    serde_json::from_slice::<Value>(payload)
        .ok()
        .and_then(|body| {
            body.get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| String::from_utf8_lossy(payload).into_owned())
        .chars()
        .take(ERROR_MESSAGE_MAX)
        .collect()
}
