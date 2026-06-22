// Context-aware tone for desktop: classify the active window title into a writing register, then
// turn that into an extra cleanup-prompt sentence. Window titles are messy (and browsers hide the
// real site), so this is a best-effort substring match that errs toward neutral. Pure + testable.

export type Register = 'casual' | 'professional' | 'technical' | 'neutral'

const CASUAL = ['whatsapp', 'slack', 'discord', 'telegram', 'messenger', 'signal', 'instagram', 'imessage', 'messages']
const PROFESSIONAL = ['gmail', 'outlook', 'linkedin', 'proton mail', 'yahoo mail']
const TECHNICAL = [
  'visual studio code', 'vs code', 'intellij', 'pycharm', 'webstorm', 'android studio',
  'sublime text', 'powershell', 'command prompt', 'terminal', 'iterm', 'github', 'cursor', 'neovim'
]

/** Classify the active window [title] into a writing register (best-effort substring match). */
export function registerForTitle(title: string): Register {
  const t = title.toLowerCase()
  if (CASUAL.some((k) => t.includes(k))) return 'casual'
  if (TECHNICAL.some((k) => t.includes(k))) return 'technical'
  if (PROFESSIONAL.some((k) => t.includes(k))) return 'professional'
  return 'neutral'
}

/** The extra cleanup-prompt sentence for [register], or null for neutral (base prompt as-is). */
export function styleDirective(register: Register): string | null {
  switch (register) {
    case 'neutral':
      return null
    case 'casual':
      return 'Keep it casual and conversational, like a quick chat message: a light touch, contractions are fine, and do not over-format or make it stiff.'
    case 'professional':
      return 'Format as polished, professional writing suitable for an email or formal message: complete sentences, proper capitalization and punctuation, and no slang.'
    case 'technical':
      return 'This is going into code or a technical tool: be concise and precise, keep all technical terms and identifiers exact, and do not add prose or pleasantries.'
  }
}
