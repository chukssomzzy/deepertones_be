// Text from the web or the model is shown to users, and none of it has any business carrying a link or markup.
// A link is a scheme or a "www." host. Markup is a "<" that starts a tag, a closing tag or a comment: straight before a
// letter, "/" or "!". Other angle brackets are ordinary text ("<1 ppm", "pH < 5", "> 2%").
const LINK = /[a-z][a-z0-9+.-]*:\/\/|\bwww\./i
const MARKUP = /<[a-z/!]/i

export const hasLink = (text: string): boolean => LINK.test(text)
export const hasMarkup = (text: string): boolean => MARKUP.test(text)
export const hasLinkOrMarkup = (text: string): boolean => hasLink(text) || hasMarkup(text)
