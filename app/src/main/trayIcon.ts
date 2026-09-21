/**
 * 托盘图标的内嵌 PNG（32x32，透明底）。
 *
 * 为什么不放成资源文件：`nativeImage.createFromPath` 走的是原生文件 IO，读不了
 * asar 里的路径，打包时得再配一份 extraResources 并处理开发与打包两套路径。
 * 这么小一张图直接内联，dev 和安装包的表现必然一致。
 *
 * 之前这里传的是 `nativeImage.createEmpty()`：托盘上什么都看不见，而关窗只是
 * hide()，用户找不到窗口也找不到退出入口，只能从任务管理器杀进程。
 */
export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAVklEQVR42u3XuwkAIAwA0Uxn6/4DOIf2ksL8EOUObPU1QiJCSr2NWXEAXHn0GAPAesEeAAAAAJQDrKUCvKUAooUAWbkA2ZkAVTGQvPkNv5qQWUxYerUWfJ4fzVAXM1QAAAAASUVORK5CYII='
