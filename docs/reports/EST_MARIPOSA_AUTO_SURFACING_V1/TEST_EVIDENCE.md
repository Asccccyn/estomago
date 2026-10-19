# TEST_EVIDENCE · EST_MARIPOSA_AUTO_SURFACING_V1

执行日 2026-10-19，本机（macOS，est UTC-7）。全部前台、分批、隔离临时根（est 独立 ESTOMAGO_HOME；mari conftest 钉临时 MARIPOSA_ROOT）。

## mariposa

| 命令 | 退出 | 结果 |
|---|---|---|
| `.venv/bin/python -m pytest -q tests/unit/test_surface_store.py tests/unit/test_surface_selection_judge.py` | 0 | **25 passed** |
| `.venv/bin/python -m pytest -q tests/unit/test_surface_capability.py` | 0 | **12 passed** |
| `.venv/bin/python -m pytest -q tests/unit/test_memory_detail.py` | 0 | **6 passed** |
| `.venv/bin/python -m pytest -q tests/integration/test_surface_http.py`（真实 FastAPI 栈+registry+schema+鉴权；fake judge transport） | 0 | **4 passed** |
| 提取等价：`pytest -q tests/unit/test_v17_recall_commit_at_end.py tests/unit/test_judge_policy_switch.py tests/unit/test_recall_session.py tests/unit/test_schema_single_source.py tests/unit/test_audit_registry_domain.py` | 0 | **67 passed** |
| judge 面：`pytest -q tests/unit/test_recall_fusion.py test_recall_judge.py test_typesafe_jev_cache.py test_codex_wiring.py` | 0 | **35 passed** |
| **全量 unit 分四批**（114 文件） | 0（2 known fail） | **1283 passed / 2 failed / 1 skipped** |

2 failed = `test_audit_20261005_fixes.py::…concurrent_rebuild_no_integrity_error`（words 惰性重建）与 `test_closure_final_20261001.py::…read_capped_stops_early`（读流上限）——**均为她在途批遗留**（e022196 提交信息明示"2 失败=该在途批遗留"），已在干净 e022196 worktree 复验与本批无关。

## estómago

| 命令 | 退出 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 0 errors |
| `npm test -- --file=tests/unit/surfacing-core.test.ts` | 0 | **6 passed**（notice 字节/渲染防泄漏/仓库状态机/源轮不注入+目标绑定+冻结复用/编辑撤销+disabled 零网络/预算跳过） |
| `npm test -- --file=tests/unit/surfacing-seam.test.ts` | 0 | **1 passed**（核心见证 6：U1 零注入、U2 回忆段在 user_input 前、U3 旧块原位不重加、retain 落账、工具集冻结含 memory_read_full） |
| `npm test -- --unit`（全量 100 文件） | 0 | **100/100 文件通过**（0 失败） |

## 跨仓真实接口（WP7 要求形态）

- M 侧：`tests/integration/test_surface_http.py` = 真实 HTTP（TestClient 全栈：鉴权→限速→registry→schema→handler→临时正式库）+ fake 外部 judge transport；信封=est 客户端 defaultTransport 同款 `{arguments}`+Bearer。
- E 侧：`tests/unit/surfacing-seam.test.ts` = E 真 MariposaClient+真实 request assembly（supervisor 全链）+ M transport 边界 fake——两侧在传输合同两端闭合。
- 真实付费 judge/生产浏览器 E2E：NOT_EXECUTED（未批准）。

## 产品验收

`ACCEPTANCE_EXECUTION.json`（本目录）：**72 项 → 64 PASS / 8 NOT_EXECUTED**（AC009/010/029/039/041(SDK 部分)/042(SDK contract 组)/049/072——语义评测付费、生产观察、SDK 桥、跨窗集成类）。
