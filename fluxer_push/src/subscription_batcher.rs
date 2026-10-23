// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::delivery::lookup;
use crate::metrics::Metrics;
use crate::rpc::{RpcClient, RpcError};
use crate::subscription::Subscription;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};

const WINDOW: Duration = Duration::from_millis(5);
const QUEUE_WAIT: Duration = Duration::from_secs(5);
const MAX_USERS: usize = 100;
const MAX_INFLIGHT: usize = 2;
type BatchResult = Result<HashMap<String, Vec<Subscription>>, RpcError>;
type Loader = Arc<
    dyn Fn(Vec<String>, Instant) -> Pin<Box<dyn Future<Output = BatchResult> + Send>> + Send + Sync,
>;
type UserResult = Result<Vec<Subscription>, Arc<RpcError>>;

/// 单个查询保留自己的截止时间和回复，不合并通知任务本身。
struct Pending {
    /// 只在内存中用于同批去重，不输出到指标。
    user: String,

    /// 沿用调用任务已有的总时间预算。
    deadline: Instant,

    /// 排队最长五秒，查询开始后不再占用排队预算。
    queued_at: tokio::time::Instant,

    /// 告知调用方查询已经开始。
    started: Option<oneshot::Sender<()>>,

    /// 为每个原任务返回独立结果。
    reply: Option<oneshot::Sender<UserResult>>,

    /// 同时限制排队和执行中的请求总数。
    _permit: OwnedSemaphorePermit,

    /// 生命周期结束时修正队列水位。
    metrics: Arc<Metrics>,

    /// 防止取消和关闭时重复扣减水位。
    queued: bool,
}

impl Drop for Pending {
    /// 被取消、过期或关闭的请求同样归还队列容量。
    fn drop(&mut self) {
        if self.queued {
            self.metrics
                .subscription_batch_queued
                .fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// 在关闭或任务取消时归还执行中批次水位。
struct Running(Arc<Metrics>);

impl Drop for Running {
    /// 即使查询任务被中止也不会残留执行中水位。
    fn drop(&mut self) {
        self.0
            .subscription_batch_inflight
            .fetch_sub(1, Ordering::Relaxed);
    }
}

/// 每个推送进程共用一个有界的清除通知设备查询缓冲区。
pub(crate) struct SubscriptionBatcher {
    tx: mpsc::Sender<Pending>,
    slots: Arc<Semaphore>,
    stop: watch::Sender<bool>,
    closed: AtomicBool,
    task: std::sync::Mutex<Option<JoinHandle<()>>>,
    metrics: Arc<Metrics>,
}

impl SubscriptionBatcher {
    /// 每批共同使用原有 RPC 重试逻辑，失败不会扇出为单用户重试。
    pub(crate) fn new(capacity: usize, rpc: Arc<RpcClient>, metrics: Arc<Metrics>) -> Self {
        let loader: Loader = Arc::new(move |users, deadline| {
            let rpc = Arc::clone(&rpc);
            Box::pin(async move {
                match tokio::time::timeout_at(
                    deadline.into(),
                    lookup(deadline, || rpc.push_subscriptions(&users)),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(unavailable("subscription batch deadline exceeded")),
                }
            })
        });
        Self::with_loader(capacity, metrics, loader)
    }

    /// 注入查询入口，便于独立验证组批和背压。
    fn with_loader(capacity: usize, metrics: Arc<Metrics>, loader: Loader) -> Self {
        let (tx, rx) = mpsc::channel(capacity);
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(run(rx, stopped, loader, Arc::clone(&metrics)));
        Self {
            tx,
            slots: Arc::new(Semaphore::new(capacity)),
            stop,
            closed: AtomicBool::new(false),
            task: std::sync::Mutex::new(Some(task)),
            metrics,
        }
    }

    /// 入队不等待空位，超量明确失败，排队和执行分别受各自截止时间约束。
    pub(crate) async fn get(&self, user: String, deadline: Instant) -> UserResult {
        self.metrics
            .subscription_batch_requests
            .fetch_add(1, Ordering::Relaxed);
        let permit = if self.closed.load(Ordering::Acquire) {
            None
        } else {
            Arc::clone(&self.slots).try_acquire_owned().ok()
        };
        let Some(permit) = permit else {
            self.metrics
                .subscription_batch_rejected
                .fetch_add(1, Ordering::Relaxed);
            return Err(Arc::new(unavailable(
                "subscription batch queue full or closed",
            )));
        };
        let (reply, response) = oneshot::channel();
        let (started, begun) = oneshot::channel();
        let queued_at = tokio::time::Instant::now();
        self.metrics
            .subscription_batch_queued
            .fetch_add(1, Ordering::Relaxed);
        let pending = Pending {
            user,
            deadline,
            queued_at,
            started: Some(started),
            reply: Some(reply),
            _permit: permit,
            metrics: Arc::clone(&self.metrics),
            queued: true,
        };
        if self.tx.try_send(pending).is_err() {
            self.metrics
                .subscription_batch_rejected
                .fetch_add(1, Ordering::Relaxed);
            return Err(Arc::new(unavailable("subscription batch queue closed")));
        }
        let queue_deadline = (queued_at + QUEUE_WAIT).min(deadline.into());
        if !matches!(
            tokio::time::timeout_at(queue_deadline, begun).await,
            Ok(Ok(()))
        ) {
            self.metrics
                .subscription_batch_expired
                .fetch_add(1, Ordering::Relaxed);
            return Err(Arc::new(unavailable(
                "subscription batch queue wait expired or closed",
            )));
        }
        match tokio::time::timeout_at(deadline.into(), response).await {
            Ok(Ok(result)) => result,
            _ => Err(Arc::new(unavailable(
                "subscription batch deadline exceeded or closed",
            ))),
        }
    }

    /// 停止接收新请求并排空已接收请求，关闭时的等待保持有界。
    pub(crate) async fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.stop.send_replace(true);
        let task = self.task.lock().unwrap().take();
        if let Some(mut task) = task {
            if tokio::time::timeout(Duration::from_secs(10), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }
}

impl Drop for SubscriptionBatcher {
    /// 所有拥有者退出后不保留后台查询任务。
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().unwrap().take() {
            task.abort();
        }
    }
}

/// 收集窗口从首个请求开始计时，执行繁忙时仍及时移除取消和过期的请求。
async fn run(
    mut rx: mpsc::Receiver<Pending>,
    mut stopped: watch::Receiver<bool>,
    loader: Loader,
    metrics: Arc<Metrics>,
) {
    let mut tasks = JoinSet::new();
    let mut pending: VecDeque<Pending> = VecDeque::new();
    let mut cleanup = tokio::time::interval(Duration::from_millis(100));
    cleanup.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if *stopped.borrow() {
            rx.close();
        }
        if rx.is_closed() && rx.is_empty() && pending.is_empty() {
            break;
        }
        let flush_at = pending.front().map(|request| request.queued_at + WINDOW);
        if tasks.len() < MAX_INFLIGHT
            && flush_at.is_some_and(|at| at <= tokio::time::Instant::now())
        {
            let mut users = HashSet::new();
            let mut batch = Vec::new();
            while users.len() < MAX_USERS {
                let Some(request) = pending.pop_front() else {
                    break;
                };
                users.insert(request.user.clone());
                batch.push(request);
            }
            let loader = Arc::clone(&loader);
            let metrics = Arc::clone(&metrics);
            tasks.spawn(async move {
                execute(batch, loader, metrics).await;
            });
            continue;
        }
        tokio::select! {
            biased;
            changed = stopped.changed(), if !rx.is_closed() => {
                if changed.is_err() || *stopped.borrow() { rx.close(); }
            }
            _ = cleanup.tick(), if !pending.is_empty() => {
                let now = tokio::time::Instant::now();
                pending.retain(|request| !request.reply.as_ref().unwrap().is_closed()
                    && now < request.queued_at + QUEUE_WAIT && now < request.deadline.into());
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            request = rx.recv(), if !rx.is_closed() || !rx.is_empty() => {
                if let Some(request) = request {
                    pending.push_back(request);
                    // 一次取出有限数量，减少唤醒，同时给超时和停机处理机会。
                    for _ in 0..999 {
                        match rx.try_recv() { Ok(request) => pending.push_back(request), Err(_) => break }
                    }
                }
            }
            _ = async {
                if let Some(at) = flush_at { tokio::time::sleep_until(at).await; }
                else { std::future::pending::<()>().await; }
            }, if tasks.len() < MAX_INFLIGHT => {}
        }
    }
    while tasks.join_next().await.is_some() {}
}

/// 查询前剔除取消或过期请求，查询结果按用户分发给原任务。
async fn execute(mut batch: Vec<Pending>, loader: Loader, metrics: Arc<Metrics>) {
    let now = tokio::time::Instant::now();
    batch.retain(|request| {
        !request.reply.as_ref().unwrap().is_closed()
            && now < request.queued_at + QUEUE_WAIT
            && now < request.deadline.into()
    });
    if batch.is_empty() {
        return;
    }
    for request in &mut batch {
        request.queued = false;
        metrics
            .subscription_batch_queued
            .fetch_sub(1, Ordering::Relaxed);
        metrics.subscription_batch_wait_ms.fetch_add(
            now.duration_since(request.queued_at).as_millis() as u64,
            Ordering::Relaxed,
        );
        let _ = request.started.take().unwrap().send(());
    }
    let users: Vec<String> = batch
        .iter()
        .map(|request| request.user.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let deadline = batch.iter().map(|request| request.deadline).min().unwrap();
    metrics
        .subscription_batch_batches
        .fetch_add(1, Ordering::Relaxed);
    metrics
        .subscription_batch_users
        .fetch_add(users.len() as u64, Ordering::Relaxed);
    metrics
        .subscription_batch_inflight
        .fetch_add(1, Ordering::Relaxed);
    let _running = Running(Arc::clone(&metrics));
    let result = loader(users, deadline).await.map_err(Arc::new);
    if result.is_err() {
        metrics
            .subscription_batch_failed
            .fetch_add(1, Ordering::Relaxed);
    }
    for mut request in batch {
        let response = match &result {
            Ok(rows) => Ok(rows.get(&request.user).cloned().unwrap_or_default()),
            Err(error) => Err(Arc::clone(error)),
        };
        let _ = request.reply.take().unwrap().send(response);
    }
}

/// 使用已有不可用错误语义，不把失败转换为没有设备。
fn unavailable(message: &str) -> RpcError {
    RpcError::Status {
        code: 503,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 构造可辨别归属的设备，检查批量结果不会串给其他用户。
    fn device(user: &str) -> Subscription {
        Subscription {
            subscription_id: user.to_owned(),
            endpoint: "test".to_owned(),
            p256dh_key: None,
            auth_key: None,
            platform: Some("android_fcm".to_owned()),
            app_id: None,
            provider_environment: None,
            thread_channels: false,
        }
    }

    /// 同步入队多个独立任务，保持每个任务都有自己的结果。
    async fn cohort(
        batcher: Arc<SubscriptionBatcher>,
        count: usize,
        unique: usize,
    ) -> Vec<UserResult> {
        let mut tasks = Vec::new();
        for index in 0..count {
            let batcher = Arc::clone(&batcher);
            tasks.push(tokio::spawn(async move {
                batcher
                    .get(
                        (index % unique).to_string(),
                        (tokio::time::Instant::now() + Duration::from_secs(60)).into_std(),
                    )
                    .await
            }));
        }
        let mut results = Vec::new();
        for task in tasks {
            results.push(task.await.unwrap());
        }
        results
    }

    #[tokio::test(start_paused = true)]
    async fn batches_one_hundred_users_deduplicates_and_splits_at_the_limit() {
        for (count, unique, expected_batches) in [(100, 100, 1), (100, 20, 1), (101, 101, 2)] {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let received = Arc::clone(&calls);
            let loader: Loader = Arc::new(move |users, _| {
                received.lock().unwrap().push(users.clone());
                Box::pin(async move {
                    Ok(users
                        .into_iter()
                        .map(|user| {
                            let sub = device(&user);
                            (user, vec![sub])
                        })
                        .collect())
                })
            });
            let metrics = Arc::new(Metrics::new());
            let batcher = Arc::new(SubscriptionBatcher::with_loader(
                200,
                Arc::clone(&metrics),
                loader,
            ));
            let results = cohort(Arc::clone(&batcher), count, unique).await;
            for (index, result) in results.into_iter().enumerate() {
                assert_eq!(
                    result.unwrap()[0].subscription_id,
                    (index % unique).to_string()
                );
            }
            let batches = calls.lock().unwrap().clone();
            assert_eq!(batches.len(), expected_batches);
            assert_eq!(batches.iter().map(Vec::len).sum::<usize>(), unique);
            assert!(batches.iter().all(|batch| batch.len() <= 100));
            batcher.shutdown().await;
            assert_eq!(metrics.subscription_batch_queued.load(Ordering::Relaxed), 0);
            assert_eq!(
                metrics.subscription_batch_inflight.load(Ordering::Relaxed),
                0
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn absent_devices_are_empty_but_rpc_errors_reach_every_waiter() {
        for failure in [false, true] {
            let loader: Loader = Arc::new(move |_, _| {
                Box::pin(async move {
                    if failure {
                        Err(unavailable("database busy"))
                    } else {
                        Ok(HashMap::new())
                    }
                })
            });
            let metrics = Arc::new(Metrics::new());
            let batcher = Arc::new(SubscriptionBatcher::with_loader(
                100,
                Arc::clone(&metrics),
                loader,
            ));
            for result in cohort(Arc::clone(&batcher), 100, 20).await {
                if failure {
                    assert!(result.is_err());
                } else {
                    assert!(result.unwrap().is_empty());
                }
            }
            assert_eq!(
                metrics.subscription_batch_batches.load(Ordering::Relaxed),
                1
            );
            assert_eq!(
                metrics.subscription_batch_failed.load(Ordering::Relaxed),
                u64::from(failure)
            );
            batcher.shutdown().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn bounds_queue_inflight_waits_and_shutdown_even_when_rpc_hangs() {
        let loader: Loader = Arc::new(|_, _| Box::pin(std::future::pending()));
        let metrics = Arc::new(Metrics::new());
        let batcher = Arc::new(SubscriptionBatcher::with_loader(
            3,
            Arc::clone(&metrics),
            loader,
        ));
        let mut tasks = Vec::new();
        for user in 0..3 {
            let instance = Arc::clone(&batcher);
            tasks.push(tokio::spawn(async move {
                instance
                    .get(
                        user.to_string(),
                        (tokio::time::Instant::now() + Duration::from_secs(60)).into_std(),
                    )
                    .await
            }));
            tokio::task::yield_now().await;
            tokio::time::advance(WINDOW).await;
            tokio::task::yield_now().await;
        }
        assert_eq!(
            metrics.subscription_batch_inflight.load(Ordering::Relaxed),
            2
        );
        assert!(
            batcher
                .get(
                    "overflow".to_owned(),
                    Instant::now() + Duration::from_secs(60)
                )
                .await
                .is_err()
        );
        tokio::time::advance(QUEUE_WAIT).await;
        tokio::task::yield_now().await;
        assert!(tasks.pop().unwrap().await.unwrap().is_err());
        batcher.shutdown().await;
        for task in tasks {
            assert!(task.await.unwrap().is_err());
        }
        assert_eq!(metrics.subscription_batch_queued.load(Ordering::Relaxed), 0);
        assert_eq!(
            metrics.subscription_batch_inflight.load(Ordering::Relaxed),
            0
        );
        assert!(
            batcher
                .get("closed".to_owned(), Instant::now())
                .await
                .is_err()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn drops_cancelled_and_expired_requests_before_querying() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&calls);
        let loader: Loader = Arc::new(move |users, _| {
            received.lock().unwrap().extend(users);
            Box::pin(async { Ok(HashMap::new()) })
        });
        let metrics = Arc::new(Metrics::new());
        let batcher = Arc::new(SubscriptionBatcher::with_loader(
            10,
            Arc::clone(&metrics),
            loader,
        ));
        let instance = Arc::clone(&batcher);
        let cancelled = tokio::spawn(async move {
            instance
                .get(
                    "cancelled".to_owned(),
                    (tokio::time::Instant::now() + Duration::from_secs(60)).into_std(),
                )
                .await
        });
        tokio::task::yield_now().await;
        cancelled.abort();
        let _ = cancelled.await;
        assert!(
            batcher
                .get("expired".to_owned(), tokio::time::Instant::now().into_std())
                .await
                .is_err()
        );
        batcher.shutdown().await;
        assert!(calls.lock().unwrap().is_empty());
        assert_eq!(metrics.subscription_batch_queued.load(Ordering::Relaxed), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_drains_accepted_queries() {
        let loader: Loader = Arc::new(|_, _| {
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(HashMap::new())
            })
        });
        let metrics = Arc::new(Metrics::new());
        let batcher = Arc::new(SubscriptionBatcher::with_loader(
            10,
            Arc::clone(&metrics),
            loader,
        ));
        let instance = Arc::clone(&batcher);
        let request = tokio::spawn(async move {
            instance
                .get(
                    "accepted".to_owned(),
                    (tokio::time::Instant::now() + Duration::from_secs(60)).into_std(),
                )
                .await
        });
        tokio::task::yield_now().await;
        batcher.shutdown().await;
        assert!(request.await.unwrap().is_ok());
        assert_eq!(batcher.slots.available_permits(), 10);
    }

    #[tokio::test]
    async fn real_rpc_retries_once_for_the_entire_batch_instead_of_each_user() {
        use crate::config::RpcConfig;
        use axum::{Router, routing::post};
        use fluxer_common::secret::SecretString;
        let calls = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let received = Arc::clone(&calls);
        let router = Router::new().route(
            "/rpc",
            post(move || {
                let attempt = received.fetch_add(1, Ordering::Relaxed);
                async move {
                    if attempt < 2 {
                        (axum::http::StatusCode::SERVICE_UNAVAILABLE, "busy")
                    } else {
                        (axum::http::StatusCode::OK, "{\"data\":{}}")
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let metrics = Arc::new(Metrics::new());
        let rpc = Arc::new(RpcClient::new(
            &RpcConfig {
                url: format!("http://{address}/rpc"),
                auth_token: SecretString::new("test".to_owned()),
            },
            reqwest::Client::new(),
            Arc::clone(&metrics),
        ));
        let batcher = Arc::new(SubscriptionBatcher::new(100, rpc, Arc::clone(&metrics)));
        for result in cohort(Arc::clone(&batcher), 100, 100).await {
            assert!(result.unwrap().is_empty());
        }
        batcher.shutdown().await;
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        assert_eq!(
            metrics.subscription_batch_batches.load(Ordering::Relaxed),
            1
        );
        server.abort();
    }

    #[tokio::test]
    async fn real_rpc_503_is_retried_per_batch_and_never_per_waiter() {
        use crate::config::RpcConfig;
        use axum::{Router, routing::post};
        use fluxer_common::secret::SecretString;
        let calls = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let received = Arc::clone(&calls);
        let router = Router::new().route(
            "/rpc",
            post(move || {
                received.fetch_add(1, Ordering::Relaxed);
                async { (axum::http::StatusCode::SERVICE_UNAVAILABLE, "busy") }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let metrics = Arc::new(Metrics::new());
        let rpc = Arc::new(RpcClient::new(
            &RpcConfig {
                url: format!("http://{address}/rpc"),
                auth_token: SecretString::new("test".to_owned()),
            },
            reqwest::Client::new(),
            Arc::clone(&metrics),
        ));
        let batcher = Arc::new(SubscriptionBatcher::new(100, rpc, Arc::clone(&metrics)));
        let mut tasks = Vec::new();
        let deadline = Instant::now() + Duration::from_millis(150);
        for user in 0..100 {
            let instance = Arc::clone(&batcher);
            tasks.push(tokio::spawn(async move {
                instance.get(user.to_string(), deadline).await
            }));
        }
        for task in tasks {
            assert!(task.await.unwrap().is_err());
        }
        batcher.shutdown().await;
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            metrics.subscription_batch_batches.load(Ordering::Relaxed),
            1
        );
        server.abort();
    }
}
