'use strict';
// Spending categories and the local (no-AI) rules that assign them.

const CATEGORIES = [
  'Groceries', 'Dining & Restaurants', 'Gas & Fuel', 'Shopping', 'Entertainment',
  'Travel & Transport', 'Health & Medical', 'Utilities & Bills',
  'Subscriptions & Streaming', 'Personal Care', 'Home & Garden', 'Education',
  'Gifts & Donations', 'Business Expenses', 'Other', 'Unknown',
];

// Confidence thresholds shared by every categorization path
const HIGH_CONFIDENCE = 0.85; // auto-apply, don't ask
const LOW_CONFIDENCE  = 0.55; // ask the user

// ---- Keyword rules ----
// Checked when a merchant isn't in saved memory. First match wins.
const AUTO_RULES = [
  // Groceries — delivery services first so instacart/shipt don't match Dining
  [/walmart|wal.mart|whole\s*food|wholefds|kroger|safeway|trader\s*joe|publix|aldi|costco|sam.s\s*club|wegmans|meijer|food\s*lion|stop\s*&?\s*shop|harris\s*teeter|sprouts|fresh\s*market|\bheb\b|winco|piggly|grocery|supermarket|market\s*basket|price\s*chopper|giant\s*food|winn.?dixie|save.?a.?lot|lidl|albertsons|vons|ralphs|smiths\s*food|fred\s*meyer|fry.s\s*food|instacart|shipt\b|fresh\s*direct|peapod|shufersal|rami\s*levy|osher\s*ad|yochananof|victory\s*market|mega\s*sport|super.?pharm|new.?pharm/i, 'Groceries'],
  // Dining & Restaurants — word boundaries on generic terms
  [/mcdonald|burger\s*king|wendy.s|taco\s*bell|chick.fil|subway|domino.s|pizza\s*hut|papa\s*john|chipotle|panera|starbucks|dunkin|krispy\s*kreme|five\s*guys|shake\s*shack|sonic\s*drive|arby.s|\bkfc\b|popeye|olive\s*garden|applebee|chili.s|outback|cheesecake\s*factory|\bihop\b|denny.s|waffle\s*house|cracker\s*barrel|grubhub|doordash|uber\s*eat|postmates|seamless|sweetgreen|cava\b|wingstop|raising\s*cane|culver.s|whataburger|jack\s*in\s*the\s*box|del\s*taco|carl.s\s*jr|hardee.s|cook\s*out|steak\s*.n.\s*shake|white\s*castle|checkers|rally.s|panda\s*express|jersey\s*mike|jimmy\s*john|firehouse\s*sub|noodles\s*&?\s*co|habit\s*burger|smashburger|portillo|golden\s*corral|texas\s*roadhouse|longhorn\s*steak|red\s*lobster|buffalo\s*wild|bww\b|yard\s*house|perkins|ihop|aroma\s*espresso|cafe\s*cafe|landwer|\bcofix\b|arcaffe|\bcaffit\b|\bfalafel\b|\bhummus\b|\bshwarma\b|\bcafe\b|\bbistro\b|\bgrill\b|\bbbq\b|\bdiner\b|\beatery\b|\btaqueria\b|\bnoodle\b|sushi|ramen|burritos|\bwing\b|pizza(?!\s*hut)/i, 'Dining & Restaurants'],
  // Gas & Fuel
  [/\bshell\b|exxon|\bmobil\b|\bbp\b|chevron|speedway|circle\s*k|wawa|sheetz|sunoco|marathon\s*gas|valero|casey.s|quiktrip|\bqt\b|pilot\s*flying|flying\s*j|love.s\s*travel|racetrac|kwik\s*trip|kwik\s*star|murphy\s*usa|holiday\s*station|\bgas\s*station\b|\bfuel\b|\bpaz\b|\bdelek\b|\bsonol\b/i, 'Gas & Fuel'],
  // Subscriptions & Streaming — before Shopping so apple/google hits here first
  [/netflix|spotify|hulu|disney\s*\+?|hbo\s*max|\bmax\b.*stream|apple\s*tv\+?|amazon\s*prime(?!\s*(now|fresh))|youtube\s*premium|peacock|paramount\+?|apple\.com\/bill|itunes|google\s*play|microsoft\s*store|nintendo\s*eshop|playstation\s*store|xbox\s*game|twitch|amc\+|shudder|criterion|curiosity\s*stream|discovery\+|espn\+|sling\s*tv|fubo|philo|starz|showtime\s*anytime|mubi|crunchyroll|sirius\s*xm|pandora\s*plus|tidal\b|audible|kindle\s*unlimited|scribd|duolingo\s*plus/i, 'Subscriptions & Streaming'],
  // Entertainment — before Shopping so Steam/tickets don't fall through
  [/\bamc\s*theatre|\bamc\s*cinema|regal\s*cine|cinemark|fandango|alamo\s*draft|harkins\b|landmark\s*theatre|cinepolis|ticketmaster|stubhub|eventbrite|\baxs\b\s*ticket|dave\s*&?\s*busters?|round\s*one\b|bowlero|main\s*event\b|topgolf|lucky\s*strike\s*ent|pinstripes|escapology|escape\s*room|androids?\s*pinball|museum\b|aquarium\b|zoo\b|theme\s*park|six\s*flags|cedar\s*fair|knotts\b|universal\s*studio|disney\s*park|steam\s*games|epicgames|humble\s*bundle|itch\.io/i, 'Entertainment'],
  // Shopping — without home depot/lowes (they belong in Home & Garden)
  [/\bamazon\b(?!\s*web)(?!\s*prime)|amzn\s*mktp|target(?!\s*optical)|ikea|tj\s*maxx|tjmaxx|marshalls|ross\s*store|nordstrom|macy.s|kohl.s|\bgap\b|old\s*navy|\bh&m\b|\bzara\b|forever\s*21|bath\s*&\s*body|victoria.s\s*secret|dick.s\s*sporting|academy\s*sport|\brei\b|\betsy\b|\bebay\b|wayfair|overstock|chewy|petco|petsmart|dollar\s*tree|dollar\s*general|five\s*below|big\s*lots|tuesday\s*morning|homegoods|pier\s*1|crate\s*&?\s*barrel|pottery\s*barn|williams.sonoma|bed\s*bath|\bbest\s*buy\b|apple\s*store|microsoft\s*surface|samsung\s*store|b&h\s*photo|adorama|newegg|gamestop|walmart\.com|target\.com|shopify\b/i, 'Shopping'],
  // Travel & Transport
  [/\blyft\b|\buber\b(?!\s*eat)|taxi|cab\s*co|airline|united\s*air|delta\s*air|american\s*air|southwest\s*air|jetblue|spirit\s*air|frontier\s*air|alaska\s*air|air\s*canada|british\s*airways|lufthansa|expedia|kayak|priceline|hotels\.com|booking\.com|airbnb|vrbo|hilton|marriott|hyatt|\bihg\b|holiday\s*inn|hampton\s*inn|wyndham|best\s*western|choice\s*hotel|radisson|hertz|avis|enterprise\s*rent|budget\s*rent|national\s*car|zipcar|amtrak|greyhound|megabus|\bparking\b|toll\s*road|e-zpass|sunpass|metro\s*transit|\btransit\b|turo\b|via\s*transport/i, 'Travel & Transport'],
  // Health & Medical — removed broad "health" term; gyms stay here
  [/cvs|walgreens|rite\s*aid|\bpharmacy\b|hospital|medical\s*ctr|medical\s*grp|\bdental\b|vision\s*care|dr\.?\s+[a-z]|urgent\s*care|minute\s*clinic|labcorp|quest\s*diag|planet\s*fitness|la\s*fitness|anytime\s*fitness|equinox|24\s*hour\s*fitness|orangetheory|orange\s*theory|peloton|lifetime\s*fitness|ymca|crunch\s*fitness|pure\s*barre|barry.s\s*bootcamp|solidcore|f45\b|blink\s*fitness|snap\s*fitness/i, 'Health & Medical'],
  // Utilities & Bills
  [/at&t|verizon|t-mobile|sprint|metro\s*pcs|spectrum|comcast|xfinity|cox\s*comm|centurylink|frontier\s*comm|optimum|\belectric\b|\butility\b|\butilities\b|water\s*bill|insurance|geico|progressive|state\s*farm|allstate|liberty\s*mutual|nationwide|usaa|aaa\s*insurance|lemonade\s*ins|hippo\s*ins|renters\s*ins|google\s*fi/i, 'Utilities & Bills'],
  // Personal Care
  [/\bsalon\b|\bbarber\b|\bspa\b|\bbeauty\b|ulta\b|sephora|great\s*clips|supercuts|cost\s*cutters|sport\s*clips|fantastic\s*sam|regis\s*salon|\bnail\b|massage\s*envy|hand\s*&?\s*stone|european\s*wax/i, 'Personal Care'],
  // Home & Garden
  [/home\s*depot|lowe.s|ace\s*hardware|true\s*value|menards|\blumber\b|\bnursery\b|garden\s*center|\bplant\b|wayfair|west\s*elm|restoration\s*hardware|\brh\b|article\s*furn/i, 'Home & Garden'],
  // Education
  [/coursera|udemy|udacity|\bedx\b|skillshare|chegg|duolingo(?!\s*plus)|khan\s*academy|brilliant\s*org|masterclass|linkedin\s*learn|pluralsight|treehouse|codecademy|tutor|tutoring|\bschool\b|\buniversity\b|\bcollege\b|tuition|student\s*loan|college\s*board|\bsat\b\s*prep|\bact\b\s*prep|pearson|mcgraw.hill|cengage|barron.s/i, 'Education'],
  // Gifts & Donations
  [/1.?800.?flower|ftd\s*flow|teleflora|proflowers|fromyouflowers|gofundme|kickstarter|patreon|red\s*cross|salvation\s*army|aspca|unicef|goodwill|habitat\s*for\s*humanity|st\.?\s*jude|charity|wikimedia|public\s*radio|npr\b|pbs\b|planned\s*parenthood|wwf\b|sierra\s*club/i, 'Gifts & Donations'],
  // Business Expenses
  [/amazon\s*web|aws\b|google\s*cloud|google\s*workspace|microsoft\s*azure|digitalocean|heroku|github|atlassian|jira\b|confluence|slack\b|zoom\b|dropbox|notion\b|airtable|hubspot|salesforce|quickbooks|freshbooks|squarespace|wix\b|mailchimp|twilio|stripe\b|sendgrid|cloudflare|fastly|datadog|pagerduty|figma\b|linear\b/i, 'Business Expenses'],
];

function autoCategory(merchant) {
  for (const [pattern, category] of AUTO_RULES) {
    if (pattern.test(merchant)) return category;
  }
  return null;
}

// Maps bank-provided category labels to our category system
const BANK_CATEGORY_MAP = {
  'food & drink': 'Dining & Restaurants', 'restaurants': 'Dining & Restaurants',
  'dining': 'Dining & Restaurants', 'fast food': 'Dining & Restaurants',
  'coffee shops': 'Dining & Restaurants', 'bars': 'Dining & Restaurants',
  'groceries': 'Groceries', 'grocery stores': 'Groceries',
  'supermarkets & groceries': 'Groceries', 'supermarkets': 'Groceries',
  'gas': 'Gas & Fuel', 'gas stations': 'Gas & Fuel',
  'gas & fuel': 'Gas & Fuel', 'automotive': 'Gas & Fuel',
  'shopping': 'Shopping', 'online shopping': 'Shopping',
  'merchandise': 'Shopping', 'clothing': 'Shopping',
  'electronics': 'Shopping', 'department stores': 'Shopping',
  'general merchandise': 'Shopping', 'pet supplies': 'Shopping',
  'sporting goods': 'Shopping', 'toys': 'Shopping',
  'travel': 'Travel & Transport', 'transportation': 'Travel & Transport',
  'rideshare': 'Travel & Transport', 'hotels': 'Travel & Transport',
  'air travel': 'Travel & Transport', 'parking': 'Travel & Transport',
  'car rental': 'Travel & Transport',
  'entertainment': 'Entertainment', 'movies & dvds': 'Entertainment',
  'games': 'Entertainment', 'arts': 'Entertainment',
  'health & wellness': 'Health & Medical', 'health': 'Health & Medical',
  'medical': 'Health & Medical', 'gym': 'Health & Medical',
  'pharmacy': 'Health & Medical', 'doctor': 'Health & Medical',
  'utilities': 'Utilities & Bills', 'bills & utilities': 'Utilities & Bills',
  'phone': 'Utilities & Bills', 'internet': 'Utilities & Bills',
  'insurance': 'Utilities & Bills',
  'personal care': 'Personal Care', 'hair': 'Personal Care',
  'spa & massage': 'Personal Care', 'beauty': 'Personal Care',
  'education': 'Education', 'tuition': 'Education',
  'home': 'Home & Garden', 'home improvement': 'Home & Garden',
  'home & garden': 'Home & Garden', 'furniture': 'Home & Garden',
  'streaming': 'Subscriptions & Streaming', 'subscriptions': 'Subscriptions & Streaming',
  'music': 'Subscriptions & Streaming', 'software': 'Subscriptions & Streaming',
  'gifts': 'Gifts & Donations', 'gifts & donations': 'Gifts & Donations',
  'charity': 'Gifts & Donations', 'donations': 'Gifts & Donations',
  'business services': 'Business Expenses', 'business': 'Business Expenses',
  'professional services': 'Business Expenses', 'office supplies': 'Business Expenses',
  'other': 'Other', 'miscellaneous': 'Other',
};

function mapBankCategory(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().trim();
  return BANK_CATEGORY_MAP[key] || null;
}

// ---- Plaid personal_finance_category → Prism category. Detailed codes override primaries.
const PLAID_CATEGORY_MAP = {
  FOOD_AND_DRINK: 'Dining & Restaurants',
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
  GENERAL_MERCHANDISE: 'Shopping',
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'Gifts & Donations',
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES: 'Business Expenses',
  HOME_IMPROVEMENT: 'Home & Garden',
  MEDICAL: 'Health & Medical',
  PERSONAL_CARE: 'Personal Care',
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'Health & Medical',
  GENERAL_SERVICES_AUTOMOTIVE: 'Gas & Fuel',
  GENERAL_SERVICES_EDUCATION: 'Education',
  GENERAL_SERVICES_INSURANCE: 'Utilities & Bills',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'Gifts & Donations',
  TRANSPORTATION: 'Travel & Transport',
  TRANSPORTATION_GAS: 'Gas & Fuel',
  TRAVEL: 'Travel & Transport',
  RENT_AND_UTILITIES: 'Utilities & Bills',
  ENTERTAINMENT: 'Entertainment',
  ENTERTAINMENT_TV_AND_MOVIES: 'Subscriptions & Streaming',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'Subscriptions & Streaming',
  LOAN_PAYMENTS: 'Utilities & Bills',
  BANK_FEES: 'Other',
};

function mapPlaidCategory(pfc) {
  if (!pfc) return null;
  return PLAID_CATEGORY_MAP[pfc.detailed] || PLAID_CATEGORY_MAP[pfc.primary] || null;
}


// ---- Payments ----
// Card payments, autopay and transfers aren't spending. Anchored at the start
// or end of the descriptor to avoid false positives on real merchants.
const PAYMENT_RE = /^(payment\b|autopay\b|auto\s+pay\b|online\s+pay(ment)?\b|bill\s+pay(ment)?\b|minimum\s+pay(ment)?\b|ach\s+pay(ment)?\b|mobile\s+pay(ment)?\b|e-?pay(ment)?\b|thank\s+you\s+(for\s+)?(your\s+)?payment|payment\s+(thank\s+you|received|complete)|credit\s+card\s+pay(ment)?|balance\s+transfer)|\b(mobile\s+pay(ment)?|online\s+pay(ment)?|autopay(\s+(pay(ment)?|pymt))?|credit\s+card\s+pay(ment)?|bill\s+pay(ment)?|ach\s+pay(ment)?|pymt)[\s\-.,*]*$/i;

// Card payments as banks describe them, beyond what PAYMENT_RE (tuned for
// statement rows) catches — e.g. Chase's "AUTOMATIC PAYMENT - THANK YOU"
const PLAID_PAYMENT_RE = /\b(automatic|auto|online|mobile|internet|scheduled|recurring)\s+payment\b|\bpayment\b[\s\-–—.,*]*thank/i;

function isPayment(name) {
  const clean = String(name || '').replace(/[\s\-.,*]+$/, '');
  return PAYMENT_RE.test(clean) || PLAID_PAYMENT_RE.test(clean);
}

module.exports = {
  CATEGORIES, HIGH_CONFIDENCE, LOW_CONFIDENCE,
  AUTO_RULES, autoCategory, mapBankCategory, mapPlaidCategory,
  PAYMENT_RE, PLAID_PAYMENT_RE, isPayment,
};
