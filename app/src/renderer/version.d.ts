/**
 * 构建期注入的全局常量：应用版本号。
 *
 * 真值是 app/package.json 的 version，由 electron.vite.config.ts 的 define
 * 在构建时把 __APP_VERSION__ 这个标识符替换成实际字符串字面量——开发和生产走
 * 同一条路径，不会漂移成「package.json 是 0.2.0、界面显示 2.0.0」。
 *
 * 这里只是全局类型声明，没有运行时定义；真正的值来自 define 的文本替换。
 * 只有 tsconfig.app.json（渲染侧）include 了它，主进程不需要版本号，也不该有。
 */
declare global {
  /** 来自 app/package.json 的 version */
  const __APP_VERSION__: string
}

export {}
