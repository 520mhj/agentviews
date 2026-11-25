async function executionContext(cdp) {
  if (cdp.__contextId) return cdp.__contextId;
  const tree = await cdp.send('Page.getFrameTree');
  const frameId = tree.frameTree?.frame?.id;
  if (!frameId) throw new Error('无法识别当前页面 frame；停止操作');
  const world = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'AgentViews', grantUniveralAccess: false });
  if (!world.executionContextId) throw new Error('无法创建隔离的 AgentViews 执行环境');
  cdp.__contextId = world.executionContextId;
  return cdp.__contextId;
}

export async function evalJs(cdp, expression, awaitPromise = true) {
  const contextId = await executionContext(cdp);
  let result;
  try {
    result = await cdp.send('Runtime.evaluate', { expression, contextId, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
  } catch (error) {
    if (/context|navigation|destroyed/i.test(error.message)) cdp.__contextId = null;
    throw error;
  }
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    if (/context|navigation|destroyed/i.test(detail.text || detail.exception?.description || '')) cdp.__contextId = null;
    throw new Error(detail.exception?.description || detail.exception?.value || detail.text);
  }
  return result.result?.value;
}
