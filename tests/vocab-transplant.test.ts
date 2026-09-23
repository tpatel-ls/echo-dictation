import { describe, it, expect } from 'vitest'
import { transplantVocabulary } from '@shared/vocab-transplant'

// The chosen text (normally Canary's) and the vocabulary model's text (Granite given the keyword
// list) of the same clip. Only one-for-one swaps onto listed terms that sound alike are taken.
const KEYWORDS = ['Tanay', 'Jordan Whitmore', 'Kian', 'Edmar', 'Zeltra', 'BROXA', 'NWG', 'NW Global', 'Claude Code', 'Marin', 'Maren', 'Ann']

const fix = (chosen: string, vocab: string, keywords = KEYWORDS): string => transplantVocabulary(chosen, vocab, keywords).text

describe('transplantVocabulary: listed terms the chosen model misheard', () => {
  it('takes a dictionary term the chosen text heard as a common word', () => {
    expect(fix('We pay the invoices through zebra.', 'we pay the invoices through Zeltra')).toBe('We pay the invoices through Zeltra.')
  })

  it('takes an acronym one letter off', () => {
    expect(fix('Email hiring at NWD and ask.', 'email hiring at NWG and ask')).toBe('Email hiring at NWG and ask.')
  })

  it("takes a person's name, whole or a first name from a full name, possessive included", () => {
    expect(fix('Ask Edmund for the shortlist.', 'ask Edmar for the shortlist')).toBe('Ask Edmar for the shortlist.')
    expect(fix('Keen back on Monday. She will review it.', "Kian's back on Monday she will review it")).toBe(
      "Kian's back on Monday. She will review it."
    )
    expect(fix('Tell Jordon the plan.', 'Tell Jordan the plan.')).toBe('Tell Jordan the plan.')
  })

  it('takes a word of a multi-word dictionary term, and a two-word term', () => {
    expect(fix('We use Cloud every day.', 'we use Claude every day')).toBe('We use Claude every day.')
    expect(fix('They moved to MW Global last year.', 'they moved to NW Global last year')).toBe('They moved to NW Global last year.')
    expect(fix('Email hiring at NWD.', 'Email hiring at NWG.', ['hiring@NWG'])).toBe('Email hiring at NWG.')
  })

  it("keeps the chosen text's punctuation and sentence capital", () => {
    expect(fix('(zebra, mostly) fine.', 'zeltra mostly fine')).toBe('(Zeltra, mostly) fine.')
    expect(fix('Zebra is next.', 'Zeltra is next.')).toBe('Zeltra is next.')
    expect(fix('I tried brocksa… no luck', 'I tried BROXA. No luck.')).toBe('I tried BROXA… no luck')
  })

  it('reports each swap', () => {
    expect(transplantVocabulary('Pay through zebra, then NWD.', 'Pay through Zeltra then NWG', KEYWORDS).swaps).toEqual([
      { from: 'zebra', to: 'Zeltra' },
      { from: 'NWD', to: 'NWG' }
    ])
  })
})

describe('transplantVocabulary: never inserts, never guesses', () => {
  it('never inserts a listed name the chosen text lacks', () => {
    expect(fix('The draft is in here.', 'The draft is Jordan.')).toBe('The draft is in here.')
    expect(fix('Then, okay, here is the plan.', 'then, okay, Jordan, here is the plan')).toBe('Then, okay, here is the plan.')
    expect(fix('We we only want', 'We only want Jordan')).toBe('We we only want')
    expect(fix('', 'Jordan')).toBe('')
  })

  it('needs the two texts to agree on some words, unless each is a single word', () => {
    expect(fix('Pardon the delay', "Paden, you're late.", ['Paden'])).toBe('Pardon the delay')
    expect(fix('Zebra.', 'Zeltra')).toBe('Zeltra.')
  })

  it('never drops or merges words', () => {
    expect(fix('So so twelve, fine?', 'So Marin fine?')).toBe('So so twelve, fine?')
    expect(fix('Ask Jordan White more.', 'Ask Jordan Whitmore.')).toBe('Ask Jordan White more.')
  })

  it('leaves a word the vocabulary model changed into something that is not a listed term', () => {
    expect(fix('We use Cloud every day.', 'We use Clod every day.')).toBe('We use Cloud every day.')
  })

  it('leaves a listed term that does not sound like the word it would replace', () => {
    expect(fix('Okay, fine.', 'Okay, Jordan.')).toBe('Okay, fine.')
    expect(fix('Thanks, man.', 'Thanks, Kian.')).toBe('Thanks, man.')
    expect(fix('Send the budget.', 'Send the Zeltra.')).toBe('Send the budget.')
  })

  it('never replaces small function words or a word that is already a listed term', () => {
    expect(fix('Tanay and Jordan agreed.', 'Tanay Ann Jordan agreed.')).toBe('Tanay and Jordan agreed.')
    expect(fix('Marin said so.', 'Maren said so.')).toBe('Marin said so.')
    // A contraction is never a name, however alike it sounds ("I'll tend" for a listed "Alden").
    expect(fix("I'll tend to it later.", 'Alden Price to it later.', ['Alden Price'])).toBe("I'll tend to it later.")
    expect(fix("Well, we'll see.", 'Well, Wilson see.', ['Wilson'])).toBe("Well, we'll see.")
  })

  it('leaves a long run of disagreement alone', () => {
    expect(fix('the zebra wind blew over', 'Zeltra Kian NWG Edmar Jordan')).toBe('the zebra wind blew over')
  })

  it('does nothing without keywords or without the vocabulary text', () => {
    expect(fix('We pay through zebra.', 'We pay through Zeltra.', [])).toBe('We pay through zebra.')
    expect(fix('We pay through zebra.', '')).toBe('We pay through zebra.')
  })
})
