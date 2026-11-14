/**
 * 全局构建期常量。
 *
 * 由 vite.config.ts 的 `define` 注入，值在构建时被静态替换。
 * 这两个值是「装上去的是哪一版」的唯一凭据：
 *   - APP_VERSION 来自 package.json（版本号单一来源）
 *   - BUILD_ID    来自构建时的 git 短哈希 + UTC 时间戳
 *
 * 任何地方都不允许再手写版本号字符串。
 */
declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;

export const APP_VERSION: string = __APP_VERSION__;
export const BUILD_ID: string = __BUILD_ID__;
