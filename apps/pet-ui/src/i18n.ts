export const uiMessages = {
  'zh-CN': {
    'status.connected': '已连接',
    'status.connecting': '正在连接…',
    'status.offline': '离线',
    'error.conflict': '内容刚刚被其他操作更新了，请载入最新版本后重试。',
    'error.unauthorized': 'petd 鉴权失败，请检查连接配置。',
    'error.timeout': '请求超时了，请稍后重试。',
    'error.unavailable': '服务暂时不可用，请稍后重试。',
    'error.notFound': '找不到这条记录，可能已被删除。',
    'error.badParams': '输入内容不符合要求，请检查后重试。',
    'error.forbidden': '该操作当前不允许执行，请检查权限或确认设置。',
    'error.internal': '服务处理时遇到问题，请稍后重试。',
    'tools.title': '工具活动',
    'tools.succeeded': '完成',
    'tools.failed': '未完成',
    'tools.dsh': '交给 DSH',
  },
} as const;

export type UiMessageKey = keyof typeof uiMessages['zh-CN'];
export function t(key: UiMessageKey): string { return uiMessages['zh-CN'][key]; }
