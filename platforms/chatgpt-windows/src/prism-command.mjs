export function parsePrismCommand(text) {
  if (typeof text !== 'string' || text.length > 256) throw new Error('Enter a short Prism command.');
  const [command, value, extra] = text.trim().replace(/^\/prism(?:\s+|$)/i, '').toLowerCase().split(/\s+/);
  if (extra) throw new Error('Use one command at a time.');
  if (['choose', 'pick', 'reset', 'hide', 'show'].includes(command) && !value) return { action: command === 'pick' ? 'choose' : command };
  if (command === 'dim' && /^\d+(?:\.\d+)?%?$/.test(value ?? '')) {
    const number = Number(value.replace('%', ''));
    if (number >= 0 && number <= 100) return { action: 'update', settings: { dim: number / 100 } };
  }
  if (command === 'fit' && ['cover', 'contain'].includes(value)) return { action: 'update', settings: { fit: value } };
  if (command === 'position' && ['center', 'top', 'bottom', 'left', 'right'].includes(value)) return { action: 'update', settings: { position: value } };
  throw new Error('Try: choose, dim 40, fit contain, position top, hide, or reset.');
}
