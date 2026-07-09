/**
 * postinstall hook — 修复 viem 包发布缺陷：
 * viem 的 tsconfig.json extends "../tsconfig.base.json"，
 * 但该文件未被包含在 npm 发布包中，导致 pnpm 严格嵌套结构下 TS 语言服务器报错。
 * 此脚本动态定位 viem 包目录并创建缺失的 tsconfig.base.json。
 */
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

try {
  // 动态解析 viem 的 package.json 位置
  const viemPkgPath = require.resolve('viem/package.json');
  const viemDir = dirname(viemPkgPath);
  const baseConfigPath = resolve(viemDir, '..', 'tsconfig.base.json');

  if (existsSync(baseConfigPath)) {
    console.log('[postinstall] viem tsconfig.base.json 已存在，跳过');
  } else {
    writeFileSync(
      baseConfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            declaration: true,
            declarationMap: true,
            sourceMap: true,
            outDir: './dist',
            noEmit: true,
          },
        },
        null,
        2,
      ) + '\n',
    );
    console.log('[postinstall] 已创建 viem tsconfig.base.json →', baseConfigPath);
  }
} catch {
  console.warn('[postinstall] 未找到 viem 包，跳过 tsconfig.base.json 修复');
}
