const VALUE_FLAGS = new Set(['name', 'id', 'text', 'key', 'option', 'checked', 'selected', 'value', 'choices', 'role', 'contains', 'url', 'goal', 'kind', 'origin', 'total', 'step', 'proxy', 'timeout', 'shot', 'port', 'state', 'idle', 'beat', 'attach', 'max', 'rounds', 'tab', 'profile', 'agents', 'install-dir', 'after', 'watch-id', 'confirm', 'request-id', 'files']);

export function parse(argv) {
  const flags = {}, positional = [];
  let literals = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--' && !literals) { literals = true; continue; }
    if (!literals && argument.startsWith('--')) {
      const name = argument.slice(2);
      if (name === 'user-confirmed' && ['true', 'false'].includes(argv[index + 1])) {
        flags[name] = argv[++index] === 'true';
      } else if (VALUE_FLAGS.has(name)) {
        if (index + 1 >= argv.length) throw new Error('缺少参数值: --' + name);
        flags[name] = argv[++index];
      } else flags[name] = true;
    } else positional.push(argument);
  }
  return { cmd: positional.shift(), flags, positional };
}
