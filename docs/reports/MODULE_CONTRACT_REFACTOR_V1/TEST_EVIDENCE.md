# TEST_EVIDENCE（统一冻结提交 e5024277ff0c8ed816670352d7f5979f4e77bce4）

最终回归：`ESTOMAGO_HOME=$(mktemp -d) /opt/homebrew/bin/node scripts/run-tests.mjs --file=…(49 文件定向选择器)` → **49/49 通过，退出码 0**（2026-10-25 统一冻结轮，含裁定后全部收口：S13-S18、演练A/B、A12、P07 第一批）。

覆盖验收 ID（29/29 PASS）：
- A01 oido-get-registry-host-wiring；A02 tool-catalog-golden（sha256 770e9fef… 恒定）
- A03 probe-module-extension-drill（冻结窗口不含新模块+同窗零回退）+ tool-discovery
- A04-A09 voice-hearing/oido-facade/reaudit/joint-voice/b1*/b2/a11/dial/oido-delete-propagation
- A10 oido-substitution-isolation-drill（absent 形态）+ voice-hearing V07
- A11 a11/dial/voice-ingress；A12 call-stop-queued-turn + exec-v1-wp4 + wake-keepwarm
- A13-A14 hold-quote/event-source-range/quote-seen-scope/wp2-*/wp3-*/wp4-*/wp5-*/review-r05/recall-*
- A15-A17 surfacing-*/joint-audit-surfacing/message-retry + session-snapshot golden 逐字
- A18-A22 wake-keepwarm/exec-v1-wp4-*/full-audit-*/keepwarm-sleep/dial
- A23-A24 integration records/snapshot/history/mock-turn/ops（真实 Host HTTP+启停）
- A25 model-results/model-wire + session golden；A26 probe drill + CHANGE_LOCALITY
- A27 substitution drill；A28 退役检查（git grep legacyFallback=零、boundaries cycles=0）
- A29 本轮 49/49 + validate_delivery formatValid=true

未运行：全量 npm test（政策禁止无选择器运行）。真实收费/生产：NOT_EXECUTED（07 §6 第 4 层，需另行授权）。
