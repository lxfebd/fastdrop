import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context'
import { theme } from 'ant-design-vue'

/**
 * 主题调色板：整份界面唯一的一份颜色来源。
 *
 * 为什么需要它 —— AntDV 和 React 版 antd 有个关键差别：React 版开 cssVar 会往
 * :root 注入 --ant-color-* 变量，AntDV 不会（它的 ThemeConfig 里根本没有 cssVar
 * 这个属性，写了静默忽略）。而我们的布局层（侧栏、工具栏、状态栏）大量用
 * var(--ant-*) 写样式，变量不存在的话整块就是透明背景。
 *
 * 所以这里把颜色显式列出来，同时喂两个消费者：
 *   1. ConfigProvider 的 token —— 决定 antd 组件本体长什么样
 *   2. :root 的 --ant-* 变量 —— 决定我们自己的布局 CSS 长什么样
 *
 * 只列"语义终态"颜色，不碰 colorBgContainer / colorBgLayout 这类派生 token
 * （AntDV 的 algorithm 会从 colorBgBase 重新算一遍，写进 token 会被覆盖回去）。
 *
 * 层级约定（布局层所有组件必须遵守，别自己另起一套）：
 *   画布   = colorBgLayout     灰底，整窗背景、侧栏、状态栏
 *   卡片   = colorBgContainer  白底，浮在画布上的内容面板，1px colorBorderSecondary 描边
 *   行内   = colorBgElevated   悬浮行、输入框这类嵌在卡片里的表面
 * 白卡坐在白底上是 antd 界面最常见的塌陷：卡片和背景同色，层级就没了。
 */
export interface Palette {
  colorPrimary: string
  colorBgBase: string
  colorBgLayout: string
  colorBgContainer: string
  colorBgElevated: string
  colorPrimaryBg: string
  colorPrimaryBgHover: string
  colorPrimaryHover: string
  colorPrimaryText: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorTextQuaternary: string
  colorBorder: string
  colorBorderSecondary: string
  colorFillSecondary: string
  colorFillTertiary: string
  colorFillQuaternary: string
  /**
   * 白卡内部的浅底区块。这里故意比 antd 默认的 fill-quaternary（2% 黑）深一倍，
   * 2% 叠在白卡上肉眼几乎分辨不出，区块边界等于不存在——所以白卡里的区块统一
   * 用 panel，别再用 quaternary。
   */
  colorFillPanel: string
  /** 进度条 / 分段带轨道底色。要比 panel 再深一档，否则填色和轨道糊在一起 */
  colorFillBar: string
  colorSuccess: string
  colorSuccessBg: string
  colorWarning: string
  colorError: string
  colorErrorBg: string
}

const DARK: Palette = {
  colorPrimary: '#4096ff',
  colorBgBase: '#141414',
  colorBgLayout: '#141414',
  colorBgContainer: '#1f1f1f',
  colorBgElevated: '#2a2a2a',
  colorPrimaryBg: 'rgba(64, 150, 255, 0.15)',
  colorPrimaryBgHover: 'rgba(64, 150, 255, 0.22)',
  colorPrimaryHover: '#69b1ff',
  colorPrimaryText: '#69b1ff',
  colorText: 'rgba(255, 255, 255, 0.88)',
  colorTextSecondary: 'rgba(255, 255, 255, 0.65)',
  colorTextTertiary: 'rgba(255, 255, 255, 0.45)',
  colorTextQuaternary: 'rgba(255, 255, 255, 0.30)',
  colorBorder: '#434343',
  colorBorderSecondary: '#303030',
  colorFillSecondary: 'rgba(255, 255, 255, 0.14)',
  colorFillTertiary: 'rgba(255, 255, 255, 0.08)',
  colorFillQuaternary: 'rgba(255, 255, 255, 0.04)',
  colorFillPanel: 'rgba(255, 255, 255, 0.07)',
  colorFillBar: 'rgba(255, 255, 255, 0.13)',
  colorSuccess: '#49aa19',
  colorSuccessBg: 'rgba(73, 170, 25, 0.15)',
  colorWarning: '#e8b450',
  colorError: '#a61d24',
  colorErrorBg: '#411114',
}

const LIGHT: Palette = {
  colorPrimary: '#1677ff',
  colorBgBase: '#ffffff',
  colorBgLayout: '#f5f5f5',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorPrimaryBg: 'rgba(22, 119, 255, 0.08)',
  colorPrimaryBgHover: 'rgba(22, 119, 255, 0.14)',
  colorPrimaryHover: '#4096ff',
  colorPrimaryText: '#4096ff',
  colorText: 'rgba(0, 0, 0, 0.88)',
  colorTextSecondary: 'rgba(0, 0, 0, 0.65)',
  colorTextTertiary: 'rgba(0, 0, 0, 0.45)',
  colorTextQuaternary: 'rgba(0, 0, 0, 0.30)',
  colorBorder: '#d9d9d9',
  colorBorderSecondary: '#f0f0f0',
  colorFillSecondary: 'rgba(0, 0, 0, 0.06)',
  colorFillTertiary: 'rgba(0, 0, 0, 0.04)',
  colorFillQuaternary: 'rgba(0, 0, 0, 0.02)',
  colorFillPanel: 'rgba(0, 0, 0, 0.035)',
  colorFillBar: 'rgba(0, 0, 0, 0.09)',
  colorSuccess: '#52c41a',
  colorSuccessBg: 'rgba(82, 196, 26, 0.12)',
  colorWarning: '#faad14',
  colorError: '#ff4d4f',
  colorErrorBg: '#fff2f0',
}

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT
}

/**
 * 喂给 ConfigProvider。这里只放"种子"token——algorithm 能从它们推导的都不要碰，
 * 否则会和派生值打架（写了被覆盖回去，不报错但视觉就是漂）。
 * borderRadius 6 是当前唯一的圆角基准，布局 CSS 跟着它走：控件 6px、面板 8px。
 */
export function appTheme(dark: boolean): ThemeConfig {
  const p = palette(dark)
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: p.colorPrimary,
      colorBgBase: p.colorBgBase,
      fontSize: 14,
      borderRadius: 6,
      // 控件高度统一 32，避免行内按钮和工具栏按钮高低不一
      controlHeight: 32,
      // 紧凑感来自 padding，不是靠缩小字号
      padding: 12,
      paddingSM: 8,
    },
  }
}

/**
 * 把同一份调色板写成 CSS 变量。必须在 <html> 上（而不是组件内），这样所有
 * 布局组件的 var() 都能解析到。同时补 fontFamilyCode —— AntDV 的 token 集合里
 * 没有这个字段，React 版才有，所以这里手工定义给等宽文字用。
 */
export function applyPaletteCss(dark: boolean): void {
  const p = palette(dark)
  const vars = [
    ['--ant-color-primary', p.colorPrimary],
    ['--ant-color-primary-hover', p.colorPrimaryHover],
    ['--ant-color-bg-base', p.colorBgBase],
    ['--ant-color-bg-layout', p.colorBgLayout],
    ['--ant-color-bg-container', p.colorBgContainer],
    ['--ant-color-bg-elevated', p.colorBgElevated],
    ['--ant-color-primary-bg', p.colorPrimaryBg],
    ['--ant-color-primary-bg-hover', p.colorPrimaryBgHover],
    ['--ant-color-primary-text', p.colorPrimaryText],
    ['--ant-color-text', p.colorText],
    ['--ant-color-text-secondary', p.colorTextSecondary],
    ['--ant-color-text-tertiary', p.colorTextTertiary],
    ['--ant-color-text-quaternary', p.colorTextQuaternary],
    ['--ant-color-border', p.colorBorder],
    ['--ant-color-border-secondary', p.colorBorderSecondary],
    ['--ant-color-fill-secondary', p.colorFillSecondary],
    ['--ant-color-fill-tertiary', p.colorFillTertiary],
    ['--ant-color-fill-quaternary', p.colorFillQuaternary],
    ['--ant-color-fill-panel', p.colorFillPanel],
    ['--ant-color-fill-bar', p.colorFillBar],
    ['--ant-color-success', p.colorSuccess],
    ['--ant-color-success-bg', p.colorSuccessBg],
    ['--ant-color-warning', p.colorWarning],
    ['--ant-color-error', p.colorError],
    ['--ant-color-error-bg', p.colorErrorBg],
    ['--ant-font-family-code', "ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace"],
    // 圆角统一收口：6 与 appTheme 的 borderRadius 对齐，组件里不再写裸数字
    ['--ant-radius', '6px'],
    ['--ant-radius-lg', '8px'],
  ]
  const el = document.documentElement
  el.style.colorScheme = dark ? 'dark' : 'light'
  for (const [k, v] of vars) el.style.setProperty(k, v)
}
