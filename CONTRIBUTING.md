# 贡献

规则只有一句话：**改了行为，就补上能拦住回归的断言**。详细约定在根 [`README.md` 的「贡献」一节](README.md#贡献)。

提 PR 前请跑：

```bash
node scripts/verify-daemon.mjs && node scripts/verify-provider.mjs && node scripts/verify-bundle.mjs
```

并在 PR 描述里贴上三个计数（当前基线：32/32、88 通过 0 失败、23/23）。

两条硬约束：

1. 不要为了「让用例通过」放宽安全约束（只绑回环、Bearer token、路径白名单、`--no-sandbox` + `--disable-dev-shm-usage`、`savePath` 准入）。
2. 改 `plugin/lib/index.js` 的 `Config` 默认值必须同步根 README 的配置表；改 `dsh.bundle` / 转出口形状必须同步 `scripts/verify-bundle.mjs` 的断言。
