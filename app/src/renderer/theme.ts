import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context'
import { theme } from 'ant-design-vue'

/**
 * 主题调色板：整份界面唯一的一份颜色来源。
 *
 * 为什么需要它 —— AntDV 和 React 版 antd 有个关键差别：React 版开 cssVar 会往
 * :root 注入 --ant-color-* 变量，AntDV 不会（它的 ThemeConfig 里根本没有 cssVar
 * 这个属性，写了静默忽略）。而我们的布局层（侧栏、工具栏、状态栏）大量用
 * var(--ant-*) 写样式，变量不存在的话整块就是透明背景，跟 PySide6 那次手抄 QSS
 * 漏项是同一个死法。
 *
 * 所以这里把颜色显式列出来，同时喂两个消费者：
 *   1. ConfigProvider 的 token —— 决定 antd 组件本体长什么样
 *   2. :root 的 --ant-* 变量 —— 决定我们自己的布局 CSS 长什么样
 *
 * 只列"语义终态"颜色，不碰 colorBgContainer / colorBgLayout 这类派生 token
 * （AntDV 的 algorithm 会从 colorBgBase 重新算一遍，写进 token 会被覆盖回去）。
 */
export interface Palette {
  colorPrimary: string
  colorBgBase: string
  colorBgLayout: string
  colorBgContainer: string
  colorPrimaryBg: string
  colorPrimaryBgHover: string
  colorPrimaryText: string
  colorText: string
  colorTextSecondary: string
  colorTextTertiary: string
  colorTextQuaternary: string
  colorBorder: string
  colorBorderSecondary: string
  colorFillTertiary: string
  colorFillQuaternary: string
  colorSuccess: string
  colorError: string
  colorErrorBg: string
}

const DARK: Palette = {
  colorPrimary: '#4096ff',
  colorBgBase: '#141414',
  colorBgLayout: '#141414',
  colorBgContainer: '#1f1f1f',
  colorPrimaryBg: 'rgba(64, 150, 255, 0.15)',
  colorPrimaryBgHover: 'rgba(64, 150, 255, 0.22)',
  colorPrimaryText: '#69b1ff',
  colorText: 'rgba(255, 255, 255, 0.88)',
  colorTextSecondary: 'rgba(255, 255, 255, 0.65)',
  colorTextTertiary: 'rgba(255, 255, 255, 0.45)',
  colorTextQuaternary: 'rgba(255, 255, 255, 0.30)',
  colorBorder: '#434343',
  colorBorderSecondary: '#303030',
  colorFillTertiary: 'rgba(255, 255, 255, 0.08)',
  colorFillQuaternary: 'rgba(255, 255, 255, 0.04)',
  colorSuccess: '#49aa19',
  colorError: '#a61d24',
  colorErrorBg: '#411114',
}

const LIGHT: Palette = {
  colorPrimary: '#1677ff',
  colorBgBase: '#ffffff',
  colorBgLayout: '#f5f5f5',
  colorBgContainer: '#ffffff',
  colorPrimaryBg: 'rgba(22, 119, 255, 0.08)',
  colorPrimaryBgHover: 'rgba(22, 119, 255, 0.14)',
  colorPrimaryText: '#4096ff',
  colorText: 'rgba(0, 0, 0, 0.88)',
  colorTextSecondary: 'rgba(0, 0, 0, 0.65)',
  colorTextTertiary: 'rgba(0, 0, 0, 0.45)',
  colorTextQuaternary: 'rgba(0, 0, 0, 0.30)',
  colorBorder: '#d9d9d9',
  colorBorderSecondary: '#f0f0f0',
  colorFillTertiary: 'rgba(0, 0, 0, 0.06)',
  colorFillQuaternary: 'rgba(0, 0, 0, 0.04)',
  colorSuccess: '#52c41a',
  colorError: '#ff4d4f',
  colorErrorBg: '#fff2f0',
}

export function palette(dark: boolean): Palette {
  return dark ? DARK : LIGHT
}

/** 喂给 ConfigProvider。seed token 之外的都让 algorithm 派生。 */
export function appTheme(dark: boolean): ThemeConfig {
  const p = palette(dark)
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: p.colorPrimary,
      colorBgBase: p.colorBgBase,
      fontSize: 14,
      borderRadius: 6,
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
    ['--ant-color-bg-base', p.colorBgBase],
    ['--ant-color-bg-layout', p.colorBgLayout],
    ['--ant-color-bg-container', p.colorBgContainer],
    ['--ant-color-primary-bg', p.colorPrimaryBg],
    ['--ant-color-primary-bg-hover', p.colorPrimaryBgHover],
    ['--ant-color-primary-text', p.colorPrimaryText],
    ['--ant-color-text', p.colorText],
    ['--ant-color-text-secondary', p.colorTextSecondary],
    ['--ant-color-text-tertiary', p.colorTextTertiary],
    ['--ant-color-text-quaternary', p.colorTextQuaternary],
    ['--ant-color-border', p.colorBorder],
    ['--ant-color-border-secondary', p.colorBorderSecondary],
    ['--ant-color-fill-tertiary', p.colorFillTertiary],
    ['--ant-color-fill-quaternary', p.colorFillQuaternary],
    ['--ant-color-success', p.colorSuccess],
    ['--ant-color-error', p.colorError],
    ['--ant-color-error-bg', p.colorErrorBg],
    ['--ant-font-family-code', "ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace"],
  ]
  const el = document.documentElement
  el.style.colorScheme = dark ? 'dark' : 'light'
  for (const [k, v] of vars) el.style.setProperty(k, v)
}
