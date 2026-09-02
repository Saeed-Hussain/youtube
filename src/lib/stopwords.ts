/**
 * Words that must never be mistaken for a character name.
 *
 * Proper-noun discovery works off capitalisation, so every word that can
 * legitimately start a sentence is a false-positive risk. This list is the
 * filter. It is deliberately broad on function words and narrative openers
 * ("Because", "Picture", "Imagine") because narration scripts start sentences
 * with them constantly.
 */
export const COMMON_WORDS = new Set<string>(
  `a an the and or but if then than that this these those there here it its it's
   i you he she we they them their his her him our your my me us
   is are was were be been being am do does did done doing have has had having
   will would can could shall should may might must
   in on at to for of with by from into onto upon over under above below
   about across after against along among around before behind beneath beside
   between beyond during except inside near off out outside since through
   throughout till toward towards until up upon within without
   not no nor yes so as such very just also too only even still yet again
   all any both each either every few many more most much neither none other
   others same several some such
   what when where which who whom whose why how whether
   now today tonight yesterday tomorrow soon later already always never often
   sometimes usually
   because since while although though unless whereas however therefore thus
   meanwhile moreover furthermore nevertheless nonetheless otherwise instead
   besides indeed anyway
   picture imagine consider look listen remember notice watch think
   let lets welcome hey okay ok well right sure maybe perhaps
   first second third next last final finally another
   good great big small new old long short high low real true false
   one two three four five six seven eight nine ten hundred thousand million
   billion trillion
   mr mrs ms dr prof sir madam lord lady
   monday tuesday wednesday thursday friday saturday sunday
   january february march april may june july august september october
   november december
   part chapter section episode video channel comment comments like subscribe
   share bell notification everybody everyone everything everywhere
   something someone somebody somewhere nothing nobody nowhere anything anyone
   anybody anywhere
   thing things time times way ways day days year years people person man men
   woman women world life story stories fact facts case cases point points
   question questions answer answers reason reasons moment moments end ends
   beginning start
   drop tap smash hit push walk stay tell say said says told going gonna
   get got give given take taken make made made know known knew see seen saw
   come came go went want wanted need needed try tried
   yeah yep nope wow oh ah hmm okay
  `
    .split(/\s+/)
    .filter(Boolean),
);

/** Grammatical words dropped before scoring topical relevance of a segment. */
export const TOPIC_STOPWORDS = new Set<string>(
  `a an the and or but if then than that this these those there here it its
   i you he she we they them their his her him our your my me us
   is are was were be been being am do does did done doing have has had having
   will would can could shall should may might must
   in on at to for of with by from into onto over under
   not no so as such very just also too only even still yet again
   what when where which who whom whose why how
   about because since while though however therefore
   one two three all any some more most much many
  `
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Pronouns and role descriptors that carry a mention forward without naming
 * anyone. Used to keep a character on screen through the sentences that
 * follow their introduction instead of cutting away on every "he said".
 */
export const CARRY_FORWARD = {
  thirdPersonSingular: /\b(?:he|him|his|she|her|hers)\b/i,
  thirdPersonPlural: /\b(?:they|them|their|theirs|its)\b/i,
  /** "the artist", "the label", "his attorneys" - generic role references. */
  roleReference:
    /\b(?:the|his|her|their|its)\s+(?:[a-z]+\s+)?(?:team|camp|lawyer|lawyers|attorney|attorneys|counsel|side|label|company|corporation|brand|career|legacy|album|song|track|music|filing|appeal|case|reputation|deal|contract|response|statement|manager|management|fans|supporters|critics|rival|opponent)\b/i,
} as const;
