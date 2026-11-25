import { join } from 'node:path';

export function bridgeFailure(error, { runtime, port, diagnostics = error?.diagnostics || {} }) {
  const reason = diagnostics.peer_conflicts ? 'browser_peer_conflict'
    : diagnostics.authentication_rejections ? 'bridge_authentication_rejected'
    : diagnostics.origin_rejections ? 'bridge_origin_rejected'
    : error?.delivered ? 'bridge_result_unknown'
    : diagnostics.received_requests === 0 ? 'extension_not_polling' : 'extension_no_response';
  return { ok: false, status: 'needs_agent_review', reason, error: error?.message || 'Extension identity is missing',
    extension_path: join(runtime, 'bridge-ext'), bridge_port: port, diagnostics,
    website_requested: false, task_delivered: !!error?.delivered,
    instruction: error?.delivered
      ? '结果未知，不重放操作；只读检查扩展状态与页面证据。'
      : '先检查扩展详情的加载路径、启用状态、Service Worker 错误和端口；没有请求不等于版本过旧或网站限制。源码扩展未配对，需加载 extension_path 的安装版。不要关闭用户页或通过新开页面验证。' };
}
