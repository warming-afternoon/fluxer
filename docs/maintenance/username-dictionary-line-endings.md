# Username dictionary line endings

Both dictionaries use `split(/\r?\n/)`. Whole-file `trim()` and empty-line filtering remain unchanged. LF, CRLF and mixed files work; internal whitespace is not trimmed and bare CR is not a delimiter. Seed selection, validation, attempt limits and fallback names are unchanged.

LF deployments retain generated names. Existing CRLF deployments may produce different deterministic placeholder names with the same seed after this fix. Deploy identical code and dictionaries to API and users-service instances together. Rollback with CRLF assets restores the parsing defect and may change placeholders again; this is not a stored username migration or secret rotation.

Newly executed validation is recorded separately from historical evidence in the integration package. Test files are deliberately excluded from product patches per handoff.
