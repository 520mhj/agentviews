import { evalJs } from '../browser/evaluate.mjs';
import { agentRecovery } from '../policy/actions.mjs';
import { prepareFileSelection } from '../core/file-selection.mjs';

export async function dispatchFileUpload(cdp, selection, plan) {
  const guard = () => evalJs(cdp, 'window.__avGuardUpload ? window.__avGuardUpload() : ({ok:false,status:"needs_agent_review",reason:"missing_upload_guard"})', false);
  let objectId = null, dragStarted = false, dispatched = false, result = null;
  const finish = value => { result = value; return value; };
  try {
    const fresh = prepareFileSelection(selection.selections.map(item => item.path));
    if (fresh.fingerprint !== selection.fingerprint) return finish(agentRecovery('upload_files_changed'));
    const permission = await guard();
    if (!permission.ok) return finish(permission);
    const paths = fresh.selections.map(item => item.path);
    if (plan.method === 'trusted_drag_drop') {
      const [pointX, pointY] = plan.point;
      const data = { items: [], files: paths, dragOperationsMask: 1 };
      dragStarted = true;
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: pointX, y: pointY, data });
      const entered = await guard();
      if (!entered.ok) return finish(entered);
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: pointX, y: pointY, data });
      const ready = await guard();
      if (!ready.ok) return finish(ready);
      dispatched = true;
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: pointX, y: pointY, data });
    } else if (plan.method === 'native_file_input') {
      const reference = await cdp.send('Runtime.evaluate', { expression: 'window.__avUploadInput', contextId: cdp.__contextId, returnByValue: false });
      objectId = reference.result?.objectId;
      if (reference.exceptionDetails || !objectId) return finish(agentRecovery('upload_input_unavailable'));
      const node = await cdp.send('DOM.describeNode', { objectId });
      if (!node.node?.backendNodeId) return finish(agentRecovery('upload_input_unavailable'));
      const ready = await guard();
      if (!ready.ok) return finish(ready);
      dispatched = true;
      await cdp.send('DOM.setFileInputFiles', { files: paths, backendNodeId: node.node.backendNodeId });
    } else return finish(agentRecovery('unsupported_upload_method'));
    return finish({ ok: true, status: 'requires_verification', method: plan.method, file_count: fresh.file_count, replayed: false });
  } catch {
    return finish(agentRecovery(dispatched ? 'upload_dispatch_unknown' : 'upload_preparation_failed', { dispatched, replayed: false,
      instruction: '读取实际文件列表和上传结果再继续；不能盲目重放上传。' }));
  } finally {
    const errors = [];
    if (objectId) await cdp.send('Runtime.releaseObject', { objectId }).catch(() => errors.push('object_release_failed'));
    if (dragStarted) await cdp.send('Input.cancelDragging', {}).catch(() => errors.push('drag_cleanup_failed'));
    await evalJs(cdp, 'window.__avUploadInput=null;window.__avGuardUpload=null;true', false).catch(() => errors.push('upload_guard_cleanup_failed'));
    if (result) {
      result.cleanup_complete = !errors.length;
      if (errors.length) Object.assign(result, agentRecovery('upload_cleanup_incomplete', { dispatched, replayed: false, cleanup_errors: errors,
        instruction: '上传可能已派发，但清理未确认。保持原状态和标签页，检查连接；必要时 keep 解除原页调试附加，再观察实际文件列表，不能盲目重新上传。' }));
    }
  }
}
