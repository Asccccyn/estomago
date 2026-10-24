# 配套脚本用法与限度

所有脚本只读目标仓库，不调用网络/模型，不改生产数据。脚本自己被验证不等于产品重构已完成。

## preflight.py

```sh
python3 /执行包/scripts/preflight.py --repo "$SOURCE" > /自己的报告目录/preflight.json
```

返回0：读到本包观察基线，且没有非已知dist脏改。返回2：需要核对/环境错误。**不能把0当架构验收**。源HEAD推进时输出diff-review，不帮你自动回退或选基线。

## check_change_scope.py

```sh
python3 /执行包/scripts/check_change_scope.py --repo "$TARGET" --base <本卡开始SHA> --stage P03
```

仅检查文件范围。返回1表示越界；需要读卡和写明理由，不得直接把allowlist改成整个apps目录。临时报告应放docs/reports/约定路径，避免无关根目录未跟踪文件进入检查。脚本纳入未跟踪文件和已提交到当前分支的本卡改动。

## check_boundaries.mjs

```sh
/opt/homebrew/bin/node /执行包/scripts/check_boundaries.mjs --repo "$TARGET" --mode report
/opt/homebrew/bin/node /执行包/scripts/check_boundaries.mjs --repo "$TARGET" --mode final
```

使用目标仓现有TypeScript做AST分析，不执行业务模块。report用于基线观察，不因旧结构退出失败；final检查目标接缝存在、特定导入边界、旧host-tools是否只剩纯重导出，以及**值导入**环。完全import type的边不会误当运行时环。

它不能证明真实调用、SQL表归属、回调是否形成等待环、权限或模型可见结果。仍需人工与Host场景验证。未解析到项目内的外部依赖不纳入图；非字面量动态调用列出人工核对。不得以脚本未报错宣称“无耦合”。

## validate_delivery.py

```sh
python3 /执行包/scripts/validate_delivery.py \
  --results "$REPORT/ACCEPTANCE_RESULTS.json" --evidence-root "$REPORT" --require-complete
```

检查ID/status、PASS的提交/命令/证据路径，不验证证据内容真实，不替独立复核签字。未填模板必须不能通过require-complete。未授权的live/production PASS会被拒绝。

## 环境提醒

文件路径含空格时引号包裹；上述尖括号表示需要填当前卡真实SHA，不要原样运行。脚本失败先读错误，不关闭保护。没有python3/TypeScript时报告环境缺口，不自动安装全局新版本。
