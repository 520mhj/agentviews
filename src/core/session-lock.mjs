import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function acquireSessionLock(filename, { timeoutMs = 5000 } = {}) {
  const lock = filename + '.lock';
  const identity = randomUUID();
  const started = Date.now();
  mkdirSync(dirname(filename), { recursive: true });
  while (true) {
    try {
      const descriptor = openSync(lock, 'wx', 0o600);
      try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, identity })); }
      finally { closeSync(descriptor); }
      return () => {
        try { if (JSON.parse(readFileSync(lock, 'utf8')).identity === identity) unlinkSync(lock); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(lock, 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid session lock; manual inspection required');
        try { process.kill(owner.pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') throw new Error('存在失效任务锁，请确认原任务已停止后人工清理：' + lock); throw probe; }
      } catch (inspection) { if (inspection.code === 'ENOENT') continue; throw inspection; }
      if (Date.now() - started >= timeoutMs) throw new Error('当前任务状态正在被另一条命令使用；停止，不并发操作或重放');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
