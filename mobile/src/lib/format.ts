export function shortDate(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = (now.getTime() - d.getTime()) / 86400e3;
  if (days < 6 && days > 0) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
export const longDate = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const dayHeading = (d: Date) => d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
export const initials = (name: string) => (name || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
export const personLabel = (p: { name?: string; address?: string; email?: string }) => p.name || p.address || p.email || '';

/** "Re: Re: Hello" -> "Re: Hello" */
export function replySubject(subject: string, prefix: 'Re' | 'Fwd') {
  const base = subject.replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, '');
  return `${prefix}: ${base}`;
}
export function quote(text: string, header: string) {
  return `\n\n${header}\n${text.split('\n').map((l) => `> ${l}`).join('\n')}`;
}
