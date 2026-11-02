// Shared by the side panel and the page script: the profile's message templates, filled in.
// The profile (config/profile.json) comes from the bridge. In a template, {greeting} becomes
// greeting_named ("Hey {first},") or greeting_anonymous ("Hey there!") and {agency} becomes the
// agency's name. A template is one string or a list of lines.
self.QF_TEXT = {
  greeting(p, first) {
    return first ? (p.greeting_named || 'Hey {first},').split('{first}').join(first) : (p.greeting_anonymous || 'Hey there!');
  },
  // key: subject | message | short | tiny. A missing tiny falls back to short, a missing short to message.
  text(p, key, first, agency) {
    let t = p[key] || (key === 'tiny' && p.short) || (key !== 'subject' && p.message) || '';
    if (Array.isArray(t)) t = t.join('\n');
    return t.split('{greeting}').join(self.QF_TEXT.greeting(p, first)).split('{agency}').join(agency || 'your agency');
  },
};
