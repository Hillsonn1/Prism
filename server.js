const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Minimal CSV parser (avoids pkg subpath-export issues with csv-parse)
function parseCSVRows(text) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const parseLine = line => {
    const fields = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let f = ''; i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { f += '"'; i += 2; }
          else if (line[i] === '"') { i++; break; }
          else f += line[i++];
        }
        fields.push(f);
        if (line[i] === ',') i++;
      } else {
        const end = line.indexOf(',', i);
        if (end === -1) { fields.push(line.slice(i).trim()); break; }
        fields.push(line.slice(i, end).trim());
        i = end + 1;
      }
    }
    return fields;
  };
  const nonEmpty = lines.filter(l => l.trim());
  if (!nonEmpty.length) return [];
  const headers = parseLine(nonEmpty[0]);
  return nonEmpty.slice(1).map(line => {
    const vals = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  }).filter(r => Object.values(r).some(v => v));
}
let _Anthropic;
function getAnthropic() {
  if (!_Anthropic) _Anthropic = require('@anthropic-ai/sdk');
  return _Anthropic;
}

const app = express();
const PORT = 3000;

const isPkg = typeof process.pkg !== 'undefined';
const isElectron = !isPkg && !!process.env.ELECTRON_USER_DATA;
const APP_DATA = isElectron
  ? process.env.ELECTRON_USER_DATA
  : isPkg
    ? path.join(process.env.APPDATA || path.dirname(process.execPath), 'Prism')
    : __dirname;

// Keep the window open and log crashes to a file so errors are always visible
process.on('uncaughtException', err => {
  console.error('\n=== Prism crashed ===');
  console.error(err.stack || err.message);
  try {
    if (!fs.existsSync(APP_DATA)) fs.mkdirSync(APP_DATA, { recursive: true });
    fs.appendFileSync(
      path.join(APP_DATA, 'error.log'),
      `[${new Date().toISOString()}]\n${err.stack}\n\n`
    );
    console.error(`\nDetails saved to: ${path.join(APP_DATA, 'error.log')}`);
  } catch {}
  console.error('\nPress Ctrl+C to close.');
  setInterval(() => {}, 5000); // keep window open
});

app.use(express.json());

if (isPkg) {
  // File contents are embedded at build time via bundle-public.js — no filesystem access needed
  const bundle = require('./public-bundle');
  for (const [file, { mime, data }] of Object.entries(bundle)) {
    const content = Buffer.from(data, 'base64');
    if (file === 'index.html') app.get('/', (_req, res) => res.setHeader('Content-Type', mime).send(content));
    app.get(`/${file}`, (_req, res) => res.setHeader('Content-Type', mime).send(content));
  }
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

// Writable data lives in %APPDATA%\Prism when packaged, or ./data in dev
const DATA_DIR = (isPkg || isElectron) ? APP_DATA : path.join(__dirname, 'data');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');
const MERCHANTS_FILE = path.join(DATA_DIR, 'merchants.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const INCOME_FILE = path.join(DATA_DIR, 'income.json');
const EXPENSES_FILE = path.join(DATA_DIR, 'expenses.json');
const UPLOADS_DIR = (isPkg || isElectron)
  ? path.join(require('os').tmpdir(), 'PrismUploads')
  : path.join(__dirname, 'uploads');

const HIGH_CONFIDENCE = 0.85; // auto-apply, don't ask
const LOW_CONFIDENCE  = 0.55; // ask user to manually categorize

[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Seed settings from bundled defaults: always ensure the API key is present
if (isPkg) {
  try {
    const bundle = require('./public-bundle');
    if (bundle['settings.json']) {
      const bundledSettings = JSON.parse(Buffer.from(bundle['settings.json'].data, 'base64').toString());
      if (!fs.existsSync(SETTINGS_FILE)) {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(bundledSettings, null, 2));
      } else if (bundledSettings.anthropicApiKey) {
        const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        if (!stored.anthropicApiKey) {
          stored.anthropicApiKey = bundledSettings.anthropicApiKey;
          fs.writeFileSync(SETTINGS_FILE, JSON.stringify(stored, null, 2));
        }
      }
    }
  } catch {}
}

// In-memory cache: reads hit disk once, then return from memory.
// Writes update memory immediately and flush to disk asynchronously.
const CACHE = {};
const pendingUploads = new Map(); // uploadId → { filePath, originalName, cardName, statementName }

function loadJSON(file, defaultVal) {
  if (!(file in CACHE)) {
    try {
      CACHE[file] = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf8'))
        : defaultVal;
    } catch {
      CACHE[file] = defaultVal;
    }
  }
  return CACHE[file];
}

function saveJSON(file, data) {
  CACHE[file] = data;
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving', path.basename(file) + ':', err.message);
  }
}

const upload = multer({ dest: UPLOADS_DIR });

// ---- Auto-categorization rules ----
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

function toTitleCase(str) {
  return str
    .toLowerCase()
    .replace(/(?:^|[\s\-\/&\*])(\w)/g, m => m.toUpperCase());
}

// Known abbreviations that regex title-casing can't fix
const MERCHANT_ABBR = new Map([
  ['wholefds', 'Whole Foods'],
  ['wholefood', 'Whole Foods'],
  ['amzn mktp', 'Amazon'],
  ['amzn', 'Amazon'],
  ['amz', 'Amazon'],
  ['wal-mart', 'Walmart'],
  ['wal mart', 'Walmart'],
  ['mcdonalds', "McDonald's"],
  ['cvs/pharmacy', 'CVS Pharmacy'],
  ['cvs phrmcy', 'CVS Pharmacy'],
  ['cvs pharm', 'CVS Pharmacy'],
  ['walgreens pharmacy', 'Walgreens'],
  ['usps po', 'USPS'],
  ['usps postal', 'USPS'],
  ['apple.com/bill', 'Apple'],
  ['apple/bill', 'Apple'],
  ['itunes.com/bill', 'Apple'],
  ['google *google storage', 'Google Storage'],
  ['google *youtube', 'YouTube'],
  ['google *google one', 'Google One'],
  ['pp*', 'PayPal'],
  ['uber *trip', 'Uber'],
  ['uber*trip', 'Uber'],
  ['uber* trip', 'Uber'],
  ['uber *eats', 'Uber Eats'],
  ['uber*eats', 'Uber Eats'],
  ['uber* eats', 'Uber Eats'],
  ['uber eats', 'Uber Eats'],
  ['uber one', 'Uber One'],
  ['lyft *ride', 'Lyft'],
  ['lyft*ride', 'Lyft'],
  ['mta*nyct', 'MTA NYC Transit'],
  ['mta *nyct', 'MTA NYC Transit'],
  ['openai *chatgpt', 'ChatGPT'],
  ['openai*chatgpt', 'ChatGPT'],
  ['openai', 'OpenAI'],
  ['krispy', 'Krispy Kreme'],
  ['krispykreme', 'Krispy Kreme'],
  ['amazon mktpl', 'Amazon'],
  ['amazon mark', 'Amazon'],
  ['amazon reta', 'Amazon'],
  ['amazon.com', 'Amazon'],
  ['lululemon athletica', 'Lululemon'],
  ['lululemon', 'Lululemon'],
  ['ouraring', 'Oura Ring'],
  ['nytimes', 'New York Times'],
  ['verizon wrls', 'Verizon Wireless'],
  ['verizon wireless', 'Verizon Wireless'],
  ['etsy etsy', 'Etsy'],
  ['d j*wsj', 'Wall Street Journal'],
  ['wsj-emea', 'Wall Street Journal'],
  ['wsj.com', 'Wall Street Journal'],
  ['smartecarte', 'Smartecarte'],
  ['amex fine hotels', 'Amex Fine Hotels & Resorts'],
]);

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

// City names sorted longest-first so longer names match before shorter subsets
// (e.g. "SANFRANCISCO" matched before "FRANCISCO")
const KNOWN_CITIES = [
  'LONGISLANDCITY','SANFRANCISCO','JACKSONVILLE','INDIANAPOLIS','FORTWORTH',
  'SANANTONIO','CENTERREACH','ALBUQUERQUE','PORTSMOUTH','SCOTTSDALE',
  'MINNEAPOLIS','PITTSBURGH','BRENTWOOD','SACRAMENTO','LOUISVILLE',
  'BIRMINGHAM','HAUPPAUGE','HENDERSON','HUNTINGTON','CINCINNATI',
  'WASHINGTON','NASHVILLE','CENTERPORT','BRIDGEPORT','CENTERLINE',
  'FRESHMEADOWS','PROVIDENCE','MILWAUKEE','BALTIMORE','CHARLOTTE',
  'CAMBRIDGE','CLEVELAND','HEMPSTEAD','HICKSVILLE','COMMACK',
  'RICHMOND','SMITHTOWN','WESTBURY','AIRMONT','NANUET','SUFFERN',
  'PORTLAND','CHANDLER','MEMPHIS','ORLANDO','PHOENIX','HOUSTON','SEATTLE',
  'HARTFORD','STAMFORD','WATERBURY','GREENWICH','NORWALK','RALEIGH',
  'MINEOLA','PATCHOGUE','BAYSHORE','BABYLON','MANHASSET','MEADOWS',
  'SYOSSET','ROSLYN','ASTORIA','BAYSIDE','CORONA','ELMHURST','JACKSON',
  'FLUSHING','JAMAICA','YONKERS','BROOKLYN','HOBOKEN','NEWARK','TRENTON',
  'RIDGEWOOD','SUNNYSIDE','WOODSIDE','MASPETH','QUEENS','BRONX','FRESH',
  'BOSTON','CHICAGO','DALLAS','DENVER','ATLANTA','MIAMI','TAMPA',
  'TUCSON','FRESNO','ANAHEIM','GLENDALE','GILBERT','TEMPE','CHANDLER',
  'LASVEGAS','SANDIEGO','SANJOSE','LOSANGELES','ELPASO','BUFFALO',
  'OMAHA','WICHITA','TULSA','RENO','BOISE','NORFOLK','AURORA',
  'COLUMBUS','AUSTIN','PLANO','GARLAND','IRVINE','OXNARD',
  'WORCESTER','LOWELL','QUINCY','LEXINGTON','NEWTON',
].sort((a, b) => b.length - a.length);

// Israeli city names (sorted longest-first) — no state code in Israeli bank data
const ISRAELI_CITIES = [
  'JUERUSALEM','JERUSALEM','YERUSHALAYIM',
  'RISHONLEZION','RISHONLEZIYYON','PETAHTIQWA','PETAHTIKVA','PETAHIKVA',
  'BEERSHEBA','BEERSHEVA','KFARSABA','RAMATGAN','RAMATASHARON',
  'GIVATAYIM','HERZLIYA','KEISARYA','CAESAREA','NETANYA','ASHDOD',
  'ASHKELON','EILAT','TIBERIAS','NAZARETH','HAIFA','TELAVIV',
  'TIQWA','TIQVA','TIKVA','PETAH',
].sort((a, b) => b.length - a.length);

function quickNormalizeName(merchant) {
  let s = merchant.trim();

  // Payment processor / wallet prefixes (order matters — longer first)
  s = s.replace(/^APLPAY\s+/i, '');
  s = s.replace(/^(SQ|TST|GMF|MC|PY|PYD|WW|SP|APL|IN|DRI|WU|PP|NYX|OTTER|TOAST|CLOVER|D\s*J)\s*\*\s*/i, '');
  s = s.replace(/^(PAYPAL|VENMO|ZELLE|STRIPE|SQUARE)\s*\*\s*/i, '');

  // Long embedded reference/phone numbers in last word (e.g. "KEVA1800800199HOL")
  s = s.replace(/\d{7,}\w{0,4}\s*$/, '');
  // US phone at end of string, optionally followed by state code ("WEB CHAVER424-242-8371NJ")
  s = s.replace(/\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}[A-Z]{0,2}\s*$/gi, '');
  // US phone numbers mid-string (global, with word boundary): "(877)263-9300" or "800-568-7625"
  s = s.replace(/\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b\s*/g, ' ');
  // International / Israeli phone: "03 5202323" or "5202323tel" or "5202323 tel"
  s = s.replace(/\s+\d{6,10}\s*(tel|fax|phone)?\s*$/gi, '');
  s = s.replace(/\s+\d{2,3}\s+\d{6,8}\s*(tel|fax|phone)?\s*$/gi, '');
  // Trailing 2-digit area code directly concatenated to merchant word ("MECUHEDET03" → "MECUHEDET")
  // Only when digits follow a letter (not standalone digits like "Route 66" or "Highway 99")
  s = s.replace(/[A-Za-z]\d{2}\s*$/, m => m[0]);

  // Trailing city + state with spaces (e.g. "Starbucks Flushing NY" or "McDonald's New York NY")
  // Require 4+ char city words to avoid stripping short abbreviations like "APP NY"
  s = s.replace(/\s+(?:[A-Z][a-zA-Z'-]{3,14}\s+){0,2}([A-Z]{2})\s*$/, (match, state) =>
    US_STATES.has(state) ? '' : match
  );

  // Trailing dates embedded by the bank ("MCDONALD'S 04/15" or "CHEVRON 2024-03-01")
  s = s.replace(/\s+\d{1,2}\/\d{1,2}\/?\d{0,4}\s*$/, '');
  s = s.replace(/\s+[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\s*$/, '');

  // Concatenated city+state glued to merchant word with no space
  // e.g. "RALPH'S COFFEEMANHASSETNY" → "RALPH'S COFFEE"
  //      "URBAN PRESSFLUSHINGNY"    → "URBAN PRESS"
  let _cityWasStripped = false;
  s = s.replace(/(\S+)$/, lastWord => {
    const upper = lastWord.toUpperCase();
    if (upper.length < 7) return lastWord;
    const state = upper.slice(-2);
    if (!US_STATES.has(state)) return lastWord;
    const cityPart = upper.slice(0, -2);
    for (const city of KNOWN_CITIES) {
      if (cityPart.endsWith(city)) {
        _cityWasStripped = true;
        return lastWord.slice(0, cityPart.length - city.length);
      }
      if (cityPart === city) { _cityWasStripped = true; return ''; }
    }
    return lastWord;
  });
  s = s.trim();
  if (_cityWasStripped) {
    // Strip any city-component word that was merged into the last merchant word
    // e.g. "CARNEFRESH" → "CARNE" when FRESH was the start of "FRESH MEADOWS"
    s = s.replace(/(\S+)$/, newLast => {
      const up = newLast.toUpperCase();
      for (const part of ['FRESHMEADOWS','FRESH','NORTH','SOUTH','EAST','WEST','NEW','OLD','MOUNT','FORT','PORT','LAKE','GREAT','UPPER','LOWER','LITTLE','CENTRAL','GARDENS','HEIGHTS','MEADOWS','HILLS','RIDGE','SHORES','SPRINGS','GROVE','DALE','WOOD','SIDE','VILLE']) {
        if (up !== part && up.endsWith(part) && up.length > part.length + 2) {
          return newLast.slice(0, up.length - part.length);
        }
      }
      return newLast;
    });
    s = s.trim();
  }
  // Strip dangling 1–3 char uppercase remnants left after city stripping (e.g. "NOR")
  s = s.replace(/\s+[A-Z]{1,3}\s*$/, '').trim() || s;
  // Strip leftover city-only word at end (e.g. "QUEENS" after stripping "FLUSHING")
  s = s.replace(/\s+(\S+)\s*$/, (match, lastWord) =>
    KNOWN_CITIES.includes(lastWord.toUpperCase()) ? '' : match
  ).trim() || s;

  // --- Israeli bank statements ---
  // "Tel Aviv" often splits across a word boundary ("MEUHDETtel AVIV") — strip wherever it appears at end
  s = s.replace(/TEL\s+AVIV[-\w\s]*$/i, '').trim();

  // Israeli cities concatenated to last word (no trailing state code in Israeli bank data)
  // e.g. "LTDJERUSALEM" → "LTD", "TOREMJERUSALEM" → "TOREM"
  s = s.replace(/(\S+)$/, lastWord => {
    const upper = lastWord.toUpperCase();
    for (const city of ISRAELI_CITIES) {
      if (upper === city) return '';
      if (upper.endsWith(city) && upper.length > city.length + 1) {
        return lastWord.slice(0, -city.length);
      }
    }
    return lastWord;
  });
  s = s.trim();

  // Israeli cities as standalone spaced last word ("BRUKLYN BAKERY LTD HAIFA")
  s = s.replace(/\s+(JERUSALEM|JUERUSALEM|YERUSHALAYIM|HAIFA|NETANYA|ASHDOD|ASHKELON|EILAT|HERZLIYA|KEISARYA|CAESAREA|TIBERIAS|NAZARETH|PETAH\s+TI[QK]VA|PETAH\s+TIQWA|BEER\s+SHEVA|KFAR\s+SABA|RAMAT\s+GAN)\s*$/i, '').trim();

  // Trailing truncated phone numbers ("202-", "03-" etc. at end of string)
  s = s.replace(/\s*\d{2,}[-\s]+$/, '');

  // State code concatenated directly after a domain extension ("GETSAUCE.COMDE" → "GETSAUCE.COM")
  s = s.replace(/\.(com|net|org|app|co|io)([A-Z]{2})\s*$/gi, (match, tld, code) =>
    US_STATES.has(code.toUpperCase()) ? '.' + tld : match
  );

  // Strip embedded URLs / help domains
  s = s.replace(/\s+https?:\/\/\S*/gi, '');
  // Strip URL at end, including optional state code directly concatenated (e.g. "GETSAUCE.COMDE", "24SIX.APPNY")
  s = s.replace(/\s+\S*\.(com|net|org|app|co|io)(\/\S*)?([A-Z]{2})?\s*$/gi, (match, tld, path, stateCode) =>
    (!stateCode || US_STATES.has(stateCode.toUpperCase())) ? '' : match
  );

  // Re-run state strip after URL removal (catches "MERCHANT.COM NY" pattern)
  s = s.replace(/\s+(?:[A-Z][a-zA-Z'-]{3,14}\s+){0,2}([A-Z]{2})\s*$/, (match, state) =>
    US_STATES.has(state) ? '' : match
  );

  // URL-style names: www.merchant.com → merchant, 24six.app → 24six
  s = s.replace(/^www\./i, '').replace(/\.(com|net|org|co|app|io)\b/ig, '');

  // Parenthetical suffixes: "Merchant (City, State)"
  s = s.replace(/\s*\([^)]{0,40}\)\s*$/, '');

  // Legal suffixes
  s = s.replace(/\s*,?\s*\b(LLC|INC\.?|CORP\.?|LTD\.?|CO\.|PLC|PLLC|L\.L\.C\.?)\s*$/i, '');

  // Store / location numbers: #1234, St1234, or trailing standalone digits
  s = s.replace(/\s+#\d[\d\-]*(\s.*)?$/, '');
  s = s.replace(/\s+St\d{3,}\s*$/i, '');
  s = s.replace(/\s+\d{3,}\s*$/, '');

  // Transaction / reference codes: * CODE or *CODE at end (handles space after *)
  s = s.replace(/\s*\*\s*[A-Z0-9]{3,}\S*$/i, '');

  // eBay transaction IDs: "eBay C 18-13827-63987" / "eBay O*25-14041-09950"
  s = s.replace(/^(ebay)\s+[a-z]\s+[\d\-]+\s*$/i, '$1');
  s = s.replace(/^(ebay)\s+[a-z]\s*\*[\d\-]+\s*$/i, '$1');

  // Membership/subscriber IDs: "Walmart+ Member 04/28009..." → "Walmart+"
  s = s.replace(/\s+(member|subscr|account)\s+[\d\/\-]+.*$/i, '');

  // Repeated leading word: "Etsy Etsy ..." → "Etsy ..."
  s = s.replace(/^(\w+)\s+\1\b\s*/i, '$1 ').trim();

  // Trailing country names
  s = s.replace(/\s+(united states|united kingdom|israel)\s*$/i, '');

  s = s.replace(/\s{2,}/g, ' ').trim() || merchant.trim();

  // Abbreviation expansion (check before title-casing)
  const lower = s.toLowerCase();
  for (const [abbr, expanded] of MERCHANT_ABBR) {
    if (lower === abbr || lower.startsWith(abbr + ' ')) return expanded;
  }

  return toTitleCase(s);
}

function migrateToTitleCase() {
  const settings = loadJSON(SETTINGS_FILE, {});
  if (settings.titleCaseMigrated) return;

  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  for (const t of transactions) {
    if (t.merchant) t.merchant = toTitleCase(t.merchant);
  }
  saveJSON(TRANSACTIONS_FILE, transactions);

  const merchants = loadJSON(MERCHANTS_FILE, {});
  const updated = {};
  for (const [name, cat] of Object.entries(merchants)) updated[toTitleCase(name)] = cat;
  saveJSON(MERCHANTS_FILE, updated);

  settings.titleCaseMigrated = true;
  saveJSON(SETTINGS_FILE, settings);
  console.log('Merchant names migrated to title case.');
}

// ---- AI categorization (Claude) ----

const VALID_CATEGORIES = [
  'Groceries','Dining & Restaurants','Gas & Fuel','Shopping','Entertainment',
  'Travel & Transport','Health & Medical','Utilities & Bills',
  'Subscriptions & Streaming','Personal Care','Home & Garden','Education',
  'Gifts & Donations','Business Expenses','Other','Unknown',
];

// Payment descriptions — anchored at start OR end of string to avoid false positives
// Also matches "PYMT" abbreviation (e.g. "CAPITAL ONE AUTOPAY PYMT", "CHASE AUTOPAY PYMT")
const PAYMENT_RE = /^(payment\b|autopay\b|auto\s+pay\b|online\s+pay(ment)?\b|bill\s+pay(ment)?\b|minimum\s+pay(ment)?\b|ach\s+pay(ment)?\b|mobile\s+pay(ment)?\b|e-?pay(ment)?\b|thank\s+you\s+(for\s+)?(your\s+)?payment|payment\s+(thank\s+you|received|complete)|credit\s+card\s+pay(ment)?|balance\s+transfer)|\b(mobile\s+pay(ment)?|online\s+pay(ment)?|autopay(\s+(pay(ment)?|pymt))?|credit\s+card\s+pay(ment)?|bill\s+pay(ment)?|ach\s+pay(ment)?|pymt)[\s\-.,*]*$/i;

// System prompt is static → cached across all calls (prefix cache)
const AI_SYSTEM = `You are a credit card transaction categorizer and merchant name normalizer.

Merchants may be from any country. Israeli merchants often appear transliterated from Hebrew (e.g., SHUFERSAL, RAMI LEVY, SUPER-PHARM, AROMA ESPRESSO, COFIX, PAZ). Use your training knowledge to identify merchants — assign lower confidence (below 0.60) when genuinely uncertain.

Normalize merchant names: remove payment processor prefixes (SQ *, TST*, PAYPAL *, APL *), transaction IDs (* followed by codes like *AB12C3), store numbers (#1234), legal suffixes (LLC, INC), US state codes at the end, and expand abbreviations to readable brand names (WHOLEFDS → Whole Foods, AMZN MKTP → Amazon, WAL-MART → Walmart).

Use EXACTLY these category names (copy them verbatim):
${VALID_CATEGORIES.join(' | ')}

Confidence guide: 0.95+ obvious brand (Netflix, Shell, Walmart) · 0.80-0.94 clear type (Hair Salon, Gym) · 0.60-0.79 educated guess · below 0.60 uncertain

Return a JSON array, one object per merchant:
[{"merchant":"<exact input name>","normalized":"<clean human-readable name>","category":"<category>","confidence":<0.0-1.0>}, ...]

No markdown, no code fences, no explanation.`;

function getApiKey() {
  return (loadJSON(SETTINGS_FILE, {})).anthropicApiKey || null;
}

function parseLocationForSearch(locationStr) {
  if (!locationStr || typeof locationStr !== 'string') return null;
  const city = locationStr.split(',')[0].trim();
  if (!city) return null;
  return { type: 'approximate', city };
}

function extractJsonObjects(text) {
  // Try full array parse first
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  // Fallback: pull out each valid object individually (handles truncated arrays)
  const results = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { results.push(JSON.parse(m[0])); } catch {}
  }
  return results;
}

async function aiCategorizeBatch(batch, client) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: [{ type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Categorize these ${batch.length} merchants:\n${batch.map((m,i) => `${i+1}. "${m}"`).join('\n')}\n\nReturn a JSON array with ${batch.length} objects.`,
    }],
  });
  const allText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJsonObjects(allText);
}

async function aiCategorizeMerchants(merchants, apiKey) {
  const client = new (getAnthropic())({ apiKey });

  // Deduplicate by normalized name so we don't send the same merchant twice
  const seen = new Map(); // normalizedKey → original merchant string
  for (const m of merchants) {
    const key = m.toLowerCase().trim();
    if (!seen.has(key)) seen.set(key, m);
  }
  const dedupedList = [...seen.values()];

  const BATCH_SIZE = 25;
  const batches = [];
  for (let i = 0; i < dedupedList.length; i += BATCH_SIZE) {
    batches.push(dedupedList.slice(i, i + BATCH_SIZE));
  }

  // Run all batches in parallel
  const batchResults = await Promise.all(batches.map(b => aiCategorizeBatch(b, client).catch(() => [])));
  const rawResults = batchResults.flat();

  if (!rawResults.length) throw new Error('AI returned no parseable results');

  const cleaned = rawResults.map(r => ({
    merchant: r.merchant,
    normalized: (r.normalized || r.merchant).trim(),
    category: VALID_CATEGORIES.includes(r.category) ? r.category : 'Other',
    confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0)),
  }));

  // Fan results back out to all original duplicates
  const resultByKey = new Map(cleaned.map(r => [r.merchant.toLowerCase().trim(), r]));
  return merchants.map(m => resultByKey.get(m.toLowerCase().trim()) || {
    merchant: m, normalized: m, category: 'Other', confidence: 0,
  });
}

async function aiTextToCategory(text, merchant, apiKey) {
  const client = new (getAnthropic())({ apiKey });
  const prompt = merchant
    ? `Merchant: "${merchant}" · User says: "${text}" → category?`
    : `User says: "${text}" → spending category?`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32,
    system: [{ type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  });

  const cat = response.content[0].text.trim();
  return VALID_CATEGORIES.includes(cat) ? cat : null;
}

function findColumn(headers, candidates) {
  for (const c of candidates) {
    const found = headers.find(h => h.toLowerCase().trim() === c.toLowerCase());
    if (found) return found;
  }
  return null;
}

function parseAmount(str) {
  if (!str && str !== 0) return null;
  const n = parseFloat(String(str).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

function normalizeDate(str) {
  if (!str) return null;
  const s = str.trim();

  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    const year = y.length === 2 ? '20' + y : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // MM/DD (no year)
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) {
    const year = new Date().getFullYear();
    return `${year}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
  }

  // "Jan 15, 2024" or "January 15, 2024"
  const named = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (named) {
    const mon = MONTHS[named[1].slice(0,3).toLowerCase()];
    if (mon) return `${named[3]}-${String(mon).padStart(2,'0')}-${named[2].padStart(2,'0')}`;
  }

  // "15 Jan 2024"
  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (dmy) {
    const mon = MONTHS[dmy[2].slice(0,3).toLowerCase()];
    if (mon) return `${dmy[3]}-${String(mon).padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
  }

  // "Jan 15" (no year)
  const namedNoYear = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/);
  if (namedNoYear) {
    const mon = MONTHS[namedNoYear[1].slice(0,3).toLowerCase()];
    if (mon) return `${new Date().getFullYear()}-${String(mon).padStart(2,'0')}-${namedNoYear[2].padStart(2,'0')}`;
  }

  return s;
}

function parseCSV(content) {
  let records;
  try {
    records = parseCSVRows(content);
  } catch (e) {
    throw new Error('Could not parse CSV file: ' + e.message);
  }

  if (!records.length) return [];

  const headers = Object.keys(records[0]);

  const dateKey = findColumn(headers, ['Transaction Date', 'Date', 'Posted Date', 'Post Date', 'Trans Date', 'Posting Date']);
  const descKey = findColumn(headers, ['Description', 'Payee', 'Merchant Name', 'Name', 'Original Description', 'Merchant', 'Transaction Description']);
  const amountKey = findColumn(headers, ['Amount', 'Transaction Amount', 'Charge Amount']);
  const debitKey = findColumn(headers, ['Debit', 'Debit Amount', 'Withdrawal']);
  const creditKey = findColumn(headers, ['Credit', 'Credit Amount', 'Deposit', 'Payment Amount']);
  const typeKey = findColumn(headers, ['Type', 'Transaction Type']);
  const categoryKey = findColumn(headers, ['Category', 'Transaction Category', 'Merchant Category', 'Spending Category', 'Expense Category']);

  if (!dateKey || !descKey) {
    throw new Error(
      `Could not detect CSV format. Columns found: ${headers.join(', ')}. ` +
      `Expected columns like "Date", "Description", and "Amount".`
    );
  }


  const rawAmounts = [];
  const transactions = [];

  for (const r of records) {
    // Skip card payments by Type column (e.g. Chase)
    if (typeKey) {
      const txType = (r[typeKey] || '').trim().toLowerCase();
      if (['payment', 'credit payment', 'autopay', 'transfer'].includes(txType)) continue;
    }

    const date = normalizeDate(r[dateKey]);
    const merchant = r[descKey]?.trim();
    if (!date || !merchant) continue;

    // Skip bill payments detected by description (catches banks without a Type column)
    if (PAYMENT_RE.test(merchant)) continue;

    let amount = null;

    if (amountKey) {
      const raw = parseAmount(r[amountKey]);
      if (raw !== null) { amount = raw; rawAmounts.push(raw); }
    } else if (debitKey || creditKey) {
      const debit = parseAmount(r[debitKey]);
      const credit = parseAmount(r[creditKey]);
      if (debit && debit > 0) amount = debit;
      else if (credit && credit > 0) amount = -credit; // credits = negative
    }

    if (amount === null || amount === 0) continue;

    transactions.push({ date, merchant, amount: parseFloat(amount.toFixed(2)), csvCategory: categoryKey ? (r[categoryKey] || '').trim() : null });
  }

  // Chase-style CSVs store charges as negative numbers.
  // If the majority of amounts are negative, flip all signs so
  // expenses are positive and refunds/credits are negative.
  if (amountKey && rawAmounts.length > 0) {
    const negCount = rawAmounts.filter(a => a < 0).length;
    if (negCount > rawAmounts.length / 2) {
      transactions.forEach(t => { t.amount = parseFloat((-t.amount).toFixed(2)); });
    }
  }

  return transactions;
}

async function parsePDF(buffer) {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch {
    throw new Error('pdf-parse module not available. Run: npm install');
  }

  const data = await pdfParse(buffer);
  const lines = data.text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

  // Each pattern: [fullMatch, dateGroup, merchantGroup, amountGroup]
  const patterns = [
    // MM/DD/YYYY  MERCHANT  $XX.XX  (or without $)
    /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s{2,}(.+?)\s{2,}\$?([\d,]+\.\d{2})\s*$/,
    // MM/DD  MERCHANT  XX.XX
    /^(\d{1,2}\/\d{1,2})\s{2,}(.+?)\s{2,}\$?([\d,]+\.\d{2})\s*$/,
    // Jan 15, 2024  MERCHANT  $XX.XX  (Capital One style)
    /^([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s{2,}(.+?)\s{2,}\$?([\d,]+\.\d{2})\s*$/,
    // Jan 15  MERCHANT  $XX.XX  (Capital One without year)
    /^([A-Za-z]{3,9}\.?\s+\d{1,2})\s{2,}(.+?)\s{2,}\$?([\d,]+\.\d{2})\s*$/,
    // YYYY-MM-DD  MERCHANT  XX.XX
    /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
    // Looser single-space versions for tightly packed PDFs
    /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
    /^(\d{1,2}\/\d{1,2})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
    /^([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
    /^([A-Za-z]{3,9}\.?\s+\d{1,2})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      const m = line.match(pattern);
      if (m) {
        const date = normalizeDate(m[1]);
        // Strip leading posting dates (some banks include two dates before the merchant)
        // and trailing dates/locations. Loop handles multiple leading dates.
        let merchant = m[2].trim();
        let _prev;
        do {
          _prev = merchant;
          merchant = merchant
            .replace(/^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\s+/i, '')
            .replace(/^[A-Za-z]{3,9}\.?\s+\d{1,2}\s+/i, '')
            .replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}\s+/, '')
            .replace(/^\d{1,2}\/\d{1,2}\s+/, '')
            .replace(/\s+\d{1,2}\/\d{1,2}\/?\d{0,4}\s*$/, '')
            .replace(/\s+[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\s*$/, '')
            .trim();
        } while (merchant !== _prev && merchant.length > 0);
        const amount = parseFloat(m[3].replace(/,/g, ''));
        if (date && merchant && !isNaN(amount) && amount > 0) {
          transactions.push({ date, merchant, amount: parseFloat(amount.toFixed(2)) });
        }
        break;
      }
    }
  }

  return transactions;
}

// Step 1: receive the file and return an upload ID immediately
app.post('/api/upload/start', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (ext !== '.csv' && ext !== '.pdf') {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'Only CSV and PDF files are supported.' });
  }
  const uploadId = crypto.randomUUID();
  pendingUploads.set(uploadId, {
    filePath: req.file.path,
    originalName: req.file.originalname,
    cardName: (req.body.cardName || '').trim().slice(0, 60),
    statementName: (req.body.statementName || '').trim().slice(0, 120),
  });
  // Clean up if the stream never connects
  setTimeout(() => {
    const u = pendingUploads.get(uploadId);
    if (u) { try { fs.unlinkSync(u.filePath); } catch {} pendingUploads.delete(uploadId); }
  }, 10 * 60 * 1000);
  res.json({ uploadId });
});

// Step 2: SSE stream that parses, deduplicates, categorizes, and saves
app.get('/api/upload/stream/:id', async (req, res) => {
  const pending = pendingUploads.get(req.params.id);
  if (!pending) return res.status(404).json({ error: 'Upload not found or expired.' });
  pendingUploads.delete(req.params.id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (progress, message, extra = {}) =>
    res.write(`data: ${JSON.stringify({ progress, message, ...extra })}\n\n`);

  const { filePath, originalName, cardName, statementName } = pending;
  const ext = path.extname(originalName).toLowerCase();

  try {
    send(10, 'Parsing file…');
    let rawTransactions = [];
    if (ext === '.csv') {
      const content = fs.readFileSync(filePath, 'utf8');
      rawTransactions = parseCSV(content);
    } else {
      const buffer = fs.readFileSync(filePath);
      rawTransactions = await parsePDF(buffer);
    }
    try { fs.unlinkSync(filePath); } catch {}

    if (!rawTransactions.length) {
      send(0, 'No transactions found in this file. The format may not be supported.', { error: true });
      res.end();
      return;
    }

    send(30, 'Processing transactions…');
    const transactions = loadJSON(TRANSACTIONS_FILE, []);
    const merchants = loadJSON(MERCHANTS_FILE, {});
    const existingKeys = new Set();
    for (const t of transactions) {
      existingKeys.add(`${t.date}|${t.merchant}|${t.amount}`);
      if (t.rawSource) existingKeys.add(`${t.date}|${t.rawSource}|${t.amount}`);
    }
    const sourceLabel = statementName || originalName;
    const newTransactions = [];
    const unknownMerchants = new Map();

    for (const t of rawTransactions) {
      const rawMerchant = t.merchant;
      // Filter out payment/transfer transactions (PDFs don't pre-filter like parseCSV)
      if (PAYMENT_RE.test(rawMerchant.replace(/[\s\-.,*]+$/, ''))) continue;
      const quickName = quickNormalizeName(rawMerchant);
      const keyRaw  = `${t.date}|${rawMerchant}|${t.amount}`;
      const keyNorm = `${t.date}|${quickName}|${t.amount}`;
      if (existingKeys.has(keyRaw) || existingKeys.has(keyNorm)) continue;
      existingKeys.add(keyRaw);
      existingKeys.add(keyNorm);

      let category = merchants[quickName] || merchants[rawMerchant] || null;
      if (!category) {
        category = autoCategory(rawMerchant);
        if (category) merchants[quickName] = category;
      }
      if (!category && t.csvCategory) {
        category = mapBankCategory(t.csvCategory);
        if (category) merchants[quickName] = category;
      }
      if (!category) unknownMerchants.set(rawMerchant, quickName);

      newTransactions.push({
        id: crypto.randomUUID(),
        date: t.date,
        merchant: quickName,
        _raw: rawMerchant,
        rawSource: rawMerchant,
        amount: t.amount,
        category,
        card: cardName || undefined,
        source: sourceLabel,
        importedAt: new Date().toISOString(),
      });
    }

    const suggestions = [];
    const apiKey = getApiKey();

    if (unknownMerchants.size > 0 && apiKey) {
      const unknownList = [...unknownMerchants.keys()];
      const batchSize = 20;
      const totalBatches = Math.ceil(unknownList.length / batchSize);
      for (let b = 0; b < totalBatches; b++) {
        const batch = unknownList.slice(b * batchSize, (b + 1) * batchSize);
        const pct = Math.round(40 + (b / totalBatches) * 48);
        const rangeEnd = Math.min((b + 1) * batchSize, unknownList.length);
        send(pct, totalBatches > 1
          ? `AI: merchants ${b * batchSize + 1}–${rangeEnd} of ${unknownList.length}…`
          : `AI: categorizing ${unknownList.length} merchant${unknownList.length !== 1 ? 's' : ''}…`);
        try {
          const aiResults = await aiCategorizeMerchants(batch, apiKey);
          for (const result of aiResults) {
            const cleanName = result.normalized || unknownMerchants.get(result.merchant) || result.merchant;
            if (result.confidence >= HIGH_CONFIDENCE) {
              merchants[cleanName] = result.category;
              for (const t of newTransactions) {
                if (t._raw === result.merchant && !t.category) { t.merchant = cleanName; t.category = result.category; }
              }
              unknownMerchants.delete(result.merchant);
            } else if (result.confidence >= LOW_CONFIDENCE) {
              for (const t of newTransactions) {
                if (t._raw === result.merchant) t.merchant = cleanName;
              }
              suggestions.push({ merchant: cleanName, category: result.category, confidence: result.confidence });
              unknownMerchants.delete(result.merchant);
            }
          }
        } catch (e) {
          console.error(`Upload AI batch ${b + 1} failed:`, e.message);
        }
      }
    }

    send(92, 'Saving…');
    for (const t of newTransactions) delete t._raw;
    transactions.push(...newTransactions);
    saveJSON(TRANSACTIONS_FILE, transactions);
    saveJSON(MERCHANTS_FILE, merchants);

    send(100, 'Done!', {
      done: true,
      result: {
        imported: newTransactions.length,
        total: rawTransactions.length,
        duplicates: rawTransactions.length - newTransactions.length,
        suggestions,
        unknownMerchants: [...unknownMerchants.values()],
      },
    });
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch {}
    send(0, err.message, { error: true });
  }

  res.end();
});

// Re-run categorization on all uncategorized transactions
app.post('/api/recategorize', async (req, res) => {
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  const merchants = loadJSON(MERCHANTS_FILE, {});
  const apiKey = getApiKey();

  const uncategorized = transactions.filter(t => !t.category);
  if (!uncategorized.length) return res.json({ suggestions: [], unknownMerchants: [], autoUpdated: 0 });

  // Group transaction IDs by merchant name
  const merchantToIds = new Map();
  for (const t of uncategorized) {
    if (!merchantToIds.has(t.merchant)) merchantToIds.set(t.merchant, new Set());
    merchantToIds.get(t.merchant).add(t.id);
  }

  let autoUpdated = 0;
  const needsAI = new Set();

  // Pass 1: merchant memory + AUTO_RULES
  for (const [merchant, ids] of merchantToIds) {
    const category = merchants[merchant] || autoCategory(merchant);
    if (category) {
      merchants[merchant] = category;
      for (const t of transactions) {
        if (ids.has(t.id)) { t.category = category; autoUpdated++; }
      }
    } else {
      needsAI.add(merchant);
    }
  }

  const suggestions = [];
  const unknownMerchants = [];

  // Pass 2: AI
  if (needsAI.size > 0 && apiKey) {
    try {
      const aiResults = await aiCategorizeMerchants([...needsAI], apiKey);
      for (const result of aiResults) {
        const ids = merchantToIds.get(result.merchant) || new Set();
        const cleanName = result.normalized || result.merchant;
        if (result.confidence >= HIGH_CONFIDENCE) {
          merchants[cleanName] = result.category;
          for (const t of transactions) {
            if (ids.has(t.id)) { t.merchant = cleanName; t.category = result.category; autoUpdated++; }
          }
        } else if (result.confidence >= LOW_CONFIDENCE) {
          suggestions.push({ merchant: cleanName, category: result.category, confidence: result.confidence });
        } else {
          unknownMerchants.push(cleanName);
        }
      }
    } catch (e) {
      console.error('AI recategorize failed:', e.message);
      unknownMerchants.push(...needsAI);
    }
  } else {
    unknownMerchants.push(...needsAI);
  }

  saveJSON(TRANSACTIONS_FILE, transactions);
  saveJSON(MERCHANTS_FILE, merchants);
  res.json({ suggestions, unknownMerchants, autoUpdated });
});

// Get all transactions
app.get('/api/transactions', (req, res) => {
  res.json(loadJSON(TRANSACTIONS_FILE, []));
});

// Remove payment transactions
app.post('/api/cleanup/payments', (req, res) => {
  let transactions = loadJSON(TRANSACTIONS_FILE, []);
  const before = transactions.length;
  transactions = transactions.filter(t => !PAYMENT_RE.test(t.merchant) && !PAYMENT_RE.test(t.rawSource || '') && !PAYMENT_RE.test(t._raw || ''));
  const removed = before - transactions.length;
  saveJSON(TRANSACTIONS_FILE, transactions);
  res.json({ removed });
});

// Normalize merchant names
app.post('/api/cleanup/normalize', (req, res) => {
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  const merchants = loadJSON(MERCHANTS_FILE, {});

  // Track old→new renames
  const renames = new Map(); // oldName → newName
  let updated = 0;
  for (const t of transactions) {
    const normalized = quickNormalizeName(t.merchant);
    if (normalized !== t.merchant) {
      renames.set(t.merchant, normalized);
      t.merchant = normalized;
      updated++;
    }
  }

  // Apply renames to merchants.json: carry category over, remove old key
  for (const [oldName, newName] of renames) {
    const category = merchants[oldName];
    if (category !== undefined && !merchants[newName]) {
      merchants[newName] = category;
    }
    delete merchants[oldName];
  }

  // Remove ghost merchants (keys with 0 matching transactions)
  const activeMerchants = new Set(transactions.map(t => t.merchant));
  for (const name of Object.keys(merchants)) {
    if (!activeMerchants.has(name)) delete merchants[name];
  }

  saveJSON(TRANSACTIONS_FILE, transactions);
  saveJSON(MERCHANTS_FILE, merchants);
  res.json({ updated });
});

// AI-assisted merchant deduplication
// Sends all unique merchant names to Haiku in ONE call and gets back a merge map
app.post('/api/cleanup/ai-deduplicate', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'No API key configured — add one in Settings.' });

  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  const merchants = loadJSON(MERCHANTS_FILE, {});
  const uniqueNames = [...new Set(transactions.map(t => t.merchant))].sort();

  if (uniqueNames.length === 0) return res.json({ merged: 0 });

  let mapping = {};
  try {
    const client = new (getAnthropic())({ apiKey });
    const prompt = `You are cleaning up merchant names from credit card statements. Here is the complete list of ${uniqueNames.length} unique merchant names currently in the database:

${JSON.stringify(uniqueNames, null, 2)}

Your job: identify names that are clearly the same merchant but appear as duplicates due to typos, truncation, extra location suffixes, or slight spelling differences. Also clean up names that still have junk in them (reference codes, payment processor prefixes, garbage suffixes).

Return ONLY a JSON object mapping each name-to-change to its canonical target name. Example format:
{"Aris Baker": "Aris Bakery", "Krispykreme": "Krispy Kreme"}

Rules:
- Only include names you are CONFIDENT about
- The target (canonical) name should be another name already in the list when possible, or a clean version of it
- Do NOT merge merchants that are genuinely different places (e.g. different branches are ok to merge if the name is clearly the same merchant)
- Do NOT touch names that are already clean and unambiguous
- Strip trailing city names only when the merchant clearly exists without it (e.g. if both "Katzefet" and "Katzefet Ramat Eshko" exist, map the longer one to "Katzefet")
- For Amazon sub-entries (Amazon Mark*, Amazon Mktpl, Amazon Reta*) → map to "Amazon"
- For reference codes still embedded → strip them
- Be conservative: when in doubt, leave it alone

Respond with ONLY the JSON object, no explanation.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    // Extract JSON even if wrapped in backticks
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) mapping = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  if (Object.keys(mapping).length === 0) return res.json({ merged: 0, mapping });

  // Apply mapping to transactions and merchants.json
  const renames = new Map(Object.entries(mapping));
  let merged = 0;
  for (const t of transactions) {
    const newName = renames.get(t.merchant);
    if (newName && newName !== t.merchant) {
      t.merchant = newName;
      merged++;
    }
  }

  for (const [oldName, newName] of renames) {
    const category = merchants[oldName];
    if (category !== undefined && !merchants[newName]) merchants[newName] = category;
    delete merchants[oldName];
  }

  // Clean up any ghosts introduced by the remap
  const active = new Set(transactions.map(t => t.merchant));
  for (const name of Object.keys(merchants)) {
    if (!active.has(name)) delete merchants[name];
  }

  saveJSON(TRANSACTIONS_FILE, transactions);
  saveJSON(MERCHANTS_FILE, merchants);
  res.json({ merged, mapping });
});

// AI categorization with SSE progress streaming
app.get('/api/cleanup/categorize/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (progress, message, extra = {}) =>
    res.write(`data: ${JSON.stringify({ progress, message, ...extra })}\n\n`);

  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      send(0, 'No API key configured — add one in Settings.', { error: true, noKey: true });
      res.end();
      return;
    }

    send(10, 'Applying categorization rules…');
    const transactions = loadJSON(TRANSACTIONS_FILE, []);
    const merchants = loadJSON(MERCHANTS_FILE, {});
    const uncategorized = transactions.filter(t => !t.category);
    const merchantToIds = new Map();
    for (const t of uncategorized) {
      if (!merchantToIds.has(t.merchant)) merchantToIds.set(t.merchant, new Set());
      merchantToIds.get(t.merchant).add(t.id);
    }

    let autoUpdated = 0;
    const needsAI = new Set();
    for (const [merchant, ids] of merchantToIds) {
      const category = merchants[merchant] || autoCategory(merchant);
      if (category) {
        merchants[merchant] = category;
        for (const t of transactions) {
          if (ids.has(t.id)) { t.category = category; autoUpdated++; }
        }
      } else {
        needsAI.add(merchant);
      }
    }

    const suggestions = [];
    const unknownMerchants = [];
    if (needsAI.size > 0) {
      const aiList = [...needsAI];
      const batchSize = 20;
      const totalBatches = Math.ceil(aiList.length / batchSize);
      for (let b = 0; b < totalBatches; b++) {
        const batch = aiList.slice(b * batchSize, (b + 1) * batchSize);
        const pct = Math.round(30 + (b / totalBatches) * 60);
        const rangeEnd = Math.min((b + 1) * batchSize, aiList.length);
        send(pct, `AI: merchants ${b * batchSize + 1}–${rangeEnd} of ${aiList.length}…`);
        try {
          const aiResults = await aiCategorizeMerchants(batch, apiKey);
          for (const result of aiResults) {
            const ids = merchantToIds.get(result.merchant) || new Set();
            const cleanName = result.normalized || result.merchant;
            if (result.confidence >= HIGH_CONFIDENCE) {
              merchants[cleanName] = result.category;
              for (const t of transactions) {
                if (ids.has(t.id)) { t.merchant = cleanName; t.category = result.category; autoUpdated++; }
              }
            } else if (result.confidence >= LOW_CONFIDENCE) {
              suggestions.push({ merchant: cleanName, category: result.category, confidence: result.confidence });
            } else {
              unknownMerchants.push(cleanName);
            }
          }
        } catch (e) {
          console.error('categorize stream AI batch failed:', e.message);
          unknownMerchants.push(...batch);
        }
      }
    }

    send(95, 'Saving…');
    saveJSON(TRANSACTIONS_FILE, transactions);
    saveJSON(MERCHANTS_FILE, merchants);
    send(100, 'Complete!', { done: true, result: { autoUpdated, suggestions, unknownMerchants } });
  } catch (err) {
    send(0, `Error: ${err.message}`, { error: true });
  }

  res.end();
});

// Delete a single transaction
app.delete('/api/transactions/:id', (req, res) => {
  let transactions = loadJSON(TRANSACTIONS_FILE, []);
  const before = transactions.length;
  transactions = transactions.filter(t => t.id !== req.params.id);
  if (transactions.length === before) return res.status(404).json({ error: 'Not found' });
  saveJSON(TRANSACTIONS_FILE, transactions);
  res.json({ success: true });
});

// Add a transaction manually
app.post('/api/transactions', (req, res) => {
  const { date, merchant, amount, category, card, notes } = req.body;
  if (!date || !merchant || amount === undefined)
    return res.status(400).json({ error: 'date, merchant, and amount are required' });
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  const merchants = loadJSON(MERCHANTS_FILE, {});
  const newTxn = {
    id: crypto.randomUUID(),
    date,
    merchant: merchant.trim(),
    amount: parseFloat(parseFloat(amount).toFixed(2)),
    category: category || null,
    card: card || undefined,
    notes: notes || undefined,
    source: 'Manual',
    importedAt: new Date().toISOString(),
    manual: true,
  };
  if (category && merchant) merchants[merchant.trim()] = category;
  transactions.push(newTxn);
  saveJSON(TRANSACTIONS_FILE, transactions);
  saveJSON(MERCHANTS_FILE, merchants);
  res.json(newTxn);
});

// Update a single transaction
app.put('/api/transactions/:id', (req, res) => {
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  const idx = transactions.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  transactions[idx] = { ...transactions[idx], ...req.body };
  saveJSON(TRANSACTIONS_FILE, transactions);
  res.json(transactions[idx]);
});

// Delete all transactions (optionally by source or merchant)
app.delete('/api/transactions', (req, res) => {
  const { source, merchant } = req.query;
  let transactions = loadJSON(TRANSACTIONS_FILE, []);
  if (source) transactions = transactions.filter(t => t.source !== source);
  else if (merchant) transactions = transactions.filter(t => t.merchant !== merchant);
  else transactions = [];
  saveJSON(TRANSACTIONS_FILE, transactions);
  res.json({ success: true });
});

// Rename a merchant across all transactions and merchant memory
app.post('/api/merchants/rename', (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  const merchants = loadJSON(MERCHANTS_FILE, {});
  let updated = 0;
  for (const t of transactions) {
    if (t.merchant === oldName) { t.merchant = newName; updated++; }
  }
  if (merchants[oldName] !== undefined && !merchants[newName]) {
    merchants[newName] = merchants[oldName];
  }
  delete merchants[oldName];
  saveJSON(TRANSACTIONS_FILE, transactions);
  saveJSON(MERCHANTS_FILE, merchants);
  res.json({ success: true, updated });
});

// Get merchant memory
app.get('/api/merchants', (req, res) => {
  res.json(loadJSON(MERCHANTS_FILE, {}));
});

// Save one merchant → category mapping
app.post('/api/merchants', (req, res) => {
  const merchant = (req.body.merchant || '').trim();
  const category = (req.body.category || '').trim();
  if (!merchant || !category) return res.status(400).json({ error: 'merchant and category required' });

  const merchants = loadJSON(MERCHANTS_FILE, {});
  merchants[merchant] = category;
  saveJSON(MERCHANTS_FILE, merchants);

  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  let updated = 0;
  for (const t of transactions) {
    if (t.merchant === merchant && !t.category) {
      t.category = category;
      updated++;
    }
  }
  saveJSON(TRANSACTIONS_FILE, transactions);
  res.json({ success: true, updated });
});

// Bulk save merchant → category mappings
app.post('/api/merchants/bulk', (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' });

  const merchants = loadJSON(MERCHANTS_FILE, {});
  const transactions = loadJSON(TRANSACTIONS_FILE, []);

  for (const { merchant, category } of mappings) {
    if (merchant && category) {
      merchants[merchant] = category;
      for (const t of transactions) {
        if (t.merchant === merchant && !t.category) t.category = category;
      }
    }
  }

  saveJSON(MERCHANTS_FILE, merchants);
  saveJSON(TRANSACTIONS_FILE, transactions);
  res.json({ success: true });
});

// Delete a merchant mapping
app.delete('/api/merchants/:merchant', (req, res) => {
  const merchants = loadJSON(MERCHANTS_FILE, {});
  delete merchants[decodeURIComponent(req.params.merchant)];
  saveJSON(MERCHANTS_FILE, merchants);
  res.json({ success: true });
});

// Spending summary by category
app.get('/api/summary', (req, res) => {
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  const summary = {};
  let grandTotal = 0;

  for (const t of transactions) {
    const cat = t.category || 'Uncategorized';
    if (!summary[cat]) summary[cat] = { total: 0, count: 0 };
    summary[cat].total += t.amount;
    summary[cat].count++;
    grandTotal += t.amount;
  }

  const result = Object.entries(summary)
    .map(([category, d]) => ({
      category,
      total: parseFloat(d.total.toFixed(2)),
      count: d.count,
    }))
    .sort((a, b) => b.total - a.total);

  res.json({ categories: result, grandTotal: parseFloat(grandTotal.toFixed(2)) });
});

// List imported source files
app.get('/api/sources', (req, res) => {
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  const sources = [...new Set(transactions.map(t => t.source))].filter(Boolean);
  res.json(sources);
});

// Debug: show raw text extracted from a PDF (helps diagnose parsing failures)
app.post('/api/debug-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(buffer);
    fs.unlinkSync(req.file.path);
    res.json({ text: data.text.slice(0, 3000), lines: data.text.split('\n').slice(0, 60) });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// Get settings (never expose the actual key)
// ---- Income ----
// Recurring items are stored under the special key '_recurring' and merged into every month.
app.get('/api/income/:month', (req, res) => {
  const income = loadJSON(INCOME_FILE, {});
  const recurring = (income['_recurring'] || []).map(e => ({ ...e, recurring: true }));
  const monthly  = (income[req.params.month] || []).map(e => ({ ...e, recurring: false }));
  res.json([...recurring, ...monthly]);
});

app.post('/api/income/:month', (req, res) => {
  const { label, amount, recurring } = req.body;
  if (!label || typeof amount !== 'number' || isNaN(amount))
    return res.status(400).json({ error: 'label and amount required' });
  const income = loadJSON(INCOME_FILE, {});
  const key = recurring ? '_recurring' : req.params.month;
  if (!income[key]) income[key] = [];
  const entry = { id: crypto.randomUUID(), label: label.trim(), amount: parseFloat(amount.toFixed(2)) };
  income[key].push(entry);
  saveJSON(INCOME_FILE, income);
  res.json({ ...entry, recurring: Boolean(recurring) });
});

app.put('/api/income/:month/:id', (req, res) => {
  const { label, amount, recurring } = req.body;
  const income = loadJSON(INCOME_FILE, {});
  const id = req.params.id;
  const month = req.params.month;
  for (const key of ['_recurring', month]) {
    const entries = income[key] || [];
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) continue;
    const wasRecurring = key === '_recurring';
    const nowRecurring = recurring !== undefined ? Boolean(recurring) : wasRecurring;
    const updated = {
      ...entries[idx],
      ...(label  !== undefined ? { label:  label.trim() }                  : {}),
      ...(amount !== undefined ? { amount: parseFloat(amount.toFixed(2)) } : {}),
    };
    if (nowRecurring !== wasRecurring) {
      income[key] = entries.filter(e => e.id !== id);
      const newKey = nowRecurring ? '_recurring' : month;
      if (!income[newKey]) income[newKey] = [];
      income[newKey].push(updated);
    } else {
      entries[idx] = updated;
      income[key] = entries;
    }
    saveJSON(INCOME_FILE, income);
    return res.json({ ...updated, recurring: nowRecurring });
  }
  res.status(404).json({ error: 'Not found' });
});

app.delete('/api/income/:month/:id', (req, res) => {
  const income = loadJSON(INCOME_FILE, {});
  const id = req.params.id;
  for (const key of ['_recurring', req.params.month]) {
    const before = (income[key] || []).length;
    income[key] = (income[key] || []).filter(e => e.id !== id);
    if ((income[key] || []).length < before) { saveJSON(INCOME_FILE, income); return res.json({ success: true }); }
  }
  res.status(404).json({ error: 'Not found' });
});

app.get('/api/settings', (req, res) => {
  const settings = loadJSON(SETTINGS_FILE, {});
  res.json({
    hasApiKey: Boolean(settings.anthropicApiKey),
    budgets: settings.budgets || {},
    monthlyBudget: settings.monthlyBudget || 0,
    location: settings.location || '',
  });
});

// Save total monthly budget
app.post('/api/budget/monthly', (req, res) => {
  const { amount } = req.body;
  if (typeof amount !== 'number' || isNaN(amount))
    return res.status(400).json({ error: 'amount required' });
  const settings = loadJSON(SETTINGS_FILE, {});
  settings.monthlyBudget = amount;
  saveJSON(SETTINGS_FILE, settings);
  res.json({ success: true });
});

// Save monthly budgets
app.post('/api/budgets', (req, res) => {
  const { budgets } = req.body;
  if (!budgets || typeof budgets !== 'object')
    return res.status(400).json({ error: 'budgets object required' });
  const settings = loadJSON(SETTINGS_FILE, {});
  settings.budgets = budgets;
  saveJSON(SETTINGS_FILE, settings);
  res.json({ success: true });
});

// Save settings
app.post('/api/settings', (req, res) => {
  const { anthropicApiKey } = req.body;
  if (!anthropicApiKey) return res.status(400).json({ error: 'anthropicApiKey required' });
  const settings = loadJSON(SETTINGS_FILE, {});
  settings.anthropicApiKey = anthropicApiKey.trim();
  saveJSON(SETTINGS_FILE, settings);
  res.json({ success: true });
});

// Rename a card across all transactions
app.post('/api/cards/rename', (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  let updated = 0;
  for (const t of transactions) {
    if (t.card === oldName) { t.card = newName.trim().slice(0, 60); updated++; }
  }
  saveJSON(TRANSACTIONS_FILE, transactions);
  res.json({ success: true, updated });
});

// Save location
app.post('/api/location', (req, res) => {
  const { location } = req.body;
  if (typeof location !== 'string') return res.status(400).json({ error: 'location string required' });
  const settings = loadJSON(SETTINGS_FILE, {});
  settings.location = location.trim();
  saveJSON(SETTINGS_FILE, settings);
  res.json({ success: true });
});

// Rename a statement and/or assign a card to all its transactions
app.post('/api/sources/update', (req, res) => {
  const { oldName, newName, card } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
  const cardVal = (card || '').trim().slice(0, 60);
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  for (const t of transactions) {
    if (t.source === oldName) {
      t.source = newName;
      if (cardVal) t.card = cardVal;
      else delete t.card;
    }
  }
  saveJSON(TRANSACTIONS_FILE, transactions);
  res.json({ success: true });
});

// AI batch categorize (called on demand)
app.post('/api/ai-categorize', async (req, res) => {
  const { merchants } = req.body;
  if (!Array.isArray(merchants) || !merchants.length)
    return res.status(400).json({ error: 'merchants array required' });
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'No API key configured — add one in Settings.' });
  try {
    const results = await aiCategorizeMerchants(merchants, apiKey);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI text-to-category (powers the freeform text input in the modal)
app.post('/api/text-to-category', async (req, res) => {
  const { text, merchant } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const apiKey = getApiKey();
  if (!apiKey) return res.json({ category: null }); // no key → silently do nothing
  try {
    const category = await aiTextToCategory(text, merchant || null, apiKey);
    res.json({ category });
  } catch (err) {
    res.json({ category: null }); // fail gracefully so UI isn't broken
  }
});

// ---- Smart Merchant Identification ----
app.post('/api/identify-merchant', async (req, res) => {
  const { merchant, rawMerchant } = req.body;
  if (!merchant) return res.status(400).json({ error: 'merchant required' });
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'No API key configured — add one in Settings.' });

  const settings = loadJSON(SETTINGS_FILE, {});
  const userLocation = parseLocationForSearch(settings.location);
  const client = new (getAnthropic())({ apiKey });

  const webSearchTool = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
    ...(userLocation && { user_location: userLocation }),
  };

  // Sanitize inputs: strip quotes to prevent prompt injection
  const safeMerchant = String(merchant).replace(/["\n\r]/g, ' ').trim().slice(0, 200);
  const safeRaw = rawMerchant ? String(rawMerchant).replace(/["\n\r]/g, ' ').trim().slice(0, 200) : '';

  const prompt = `A credit card statement shows this merchant: "${safeMerchant}"${safeRaw && safeRaw !== safeMerchant ? ` (raw bank string: "${safeRaw}")` : ''}.

Identify what this business actually is. Search the web if needed. Return JSON only:
{"name":"<clean readable business name>","category":"<one of the valid categories>","description":"<1 sentence: what this business is>","confidence":<0.0-1.0>}

Valid categories: ${VALID_CATEGORIES.join(' | ')}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: [{ type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
      tools: [webSearchTool],
    });
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Could not parse result' });
    const result = JSON.parse(match[0]);
    res.json({
      name: (result.name || merchant).trim(),
      category: VALID_CATEGORIES.includes(result.category) ? result.category : 'Other',
      description: result.description || '',
      confidence: Math.min(1, Math.max(0, Number(result.confidence) || 0)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- AI Insights ----
app.post('/api/insights', async (req, res) => {
  const { month } = req.body;
  const apiKey = getApiKey();
  if (!apiKey) return res.status(400).json({ error: 'No API key configured — add one in Settings.' });

  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  const txns = month ? transactions.filter(t => t.date?.startsWith(month)) : transactions;
  if (!txns.length) return res.json({ summary: null });

  const total = txns.reduce((s, t) => s + t.amount, 0);
  const catTotals = {};
  for (const t of txns) {
    const c = t.category || 'Uncategorized';
    catTotals[c] = (catTotals[c] || 0) + t.amount;
  }
  const topCats = Object.entries(catTotals)
    .sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([cat, amt]) => `${cat}: $${amt.toFixed(0)}`).join(', ');
  const topTxn = [...txns].sort((a, b) => b.amount - a.amount)[0];

  let priorContext = '';
  if (month) {
    const [yr, mo] = month.split('-').map(Number);
    const pd = new Date(yr, mo - 2, 1);
    const priorMonth = `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}`;
    const priorTxns = transactions.filter(t => t.date?.startsWith(priorMonth));
    if (priorTxns.length) {
      const priorTotal = priorTxns.reduce((s, t) => s + t.amount, 0);
      const pct = ((total - priorTotal) / priorTotal * 100).toFixed(0);
      const dir = pct > 0 ? `up ${pct}%` : `down ${Math.abs(pct)}%`;
      const priorLabel = pd.toLocaleString('default', { month: 'long' });
      priorContext = ` (${dir} vs ${priorLabel})`;
    }
  }

  const periodLabel = month ? (() => {
    const [yr, mo] = month.split('-');
    return new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  })() : 'all time';

  const prompt = `Spending summary for ${periodLabel}:
Total: $${total.toFixed(2)}${priorContext} across ${txns.length} transactions
Top categories: ${topCats}
Largest charge: $${topTxn.amount.toFixed(2)} at ${topTxn.merchant}

Write 2-3 sentences of friendly, specific financial insight. Mention what stands out, any notable patterns, or one practical observation. Be conversational, not robotic. No bullet points or headers.`;

  try {
    const client = new (getAnthropic())({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: [{ type: 'text', text: 'You are a friendly personal finance assistant. Give short, specific, helpful spending insights in 2-3 natural sentences. No bullet points, no headers, no filler phrases like "Great news!"', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ summary: response.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Anomaly Detection ----
app.get('/api/anomalies', (req, res) => {
  const { month } = req.query;
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  if (!transactions.length) return res.json({ anomalies: [] });

  const anomalies = [];
  const current = month ? transactions.filter(t => t.date?.startsWith(month)) : transactions;

  // 1. Possible duplicates (same merchant + amount within 5 days) — one alert per cluster
  const dupWindows = new Map(); // "merchant|amount" → [{start, txns[]}]
  for (const t of [...current].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    const key = `${t.merchant}|${t.amount.toFixed(2)}`;
    const tDate = new Date(t.date);
    if (!dupWindows.has(key)) { dupWindows.set(key, [{ start: tDate, txns: [t] }]); continue; }
    const windows = dupWindows.get(key);
    const match = windows.find(w => Math.abs(tDate - w.start) <= 5 * 86400000);
    if (match) match.txns.push(t);
    else windows.push({ start: tDate, txns: [t] });
  }
  for (const [, windows] of dupWindows) {
    for (const { txns } of windows) {
      if (txns.length < 2) continue;
      const { merchant, amount } = txns[0];
      anomalies.push({ type: 'duplicate', label: 'Possible duplicate', detail: `${merchant} — $${amount.toFixed(2)} charged ${txns.length}× within 5 days` });
    }
  }

  if (month) {
    // 2. First-time high-value merchant (≥$75, never seen before this month)
    const before = transactions.filter(t => t.date && t.date < month);
    const knownMerchants = new Set(before.map(t => t.merchant.toLowerCase()));
    for (const t of current) {
      if (t.amount >= 150 && !knownMerchants.has(t.merchant.toLowerCase())) {
        anomalies.push({ type: 'new-merchant', label: 'New merchant', detail: `First charge from ${t.merchant} — $${t.amount.toFixed(2)}`, txnId: t.id });
      }
    }

  }

  res.json({ anomalies: anomalies.slice(0, 8) });
});

// ---- Budget Suggestions ----
// ---- Manual Expenses ----
app.get('/api/expenses/:month', (req, res) => {
  const all = loadJSON(EXPENSES_FILE, {});
  const recurring = (all['_recurring'] || []).map(e => ({ ...e, recurring: true }));
  const monthly  = (all[req.params.month] || []).map(e => ({ ...e, recurring: false }));
  res.json([...recurring, ...monthly]);
});

app.post('/api/expenses/:month', (req, res) => {
  const { label, amount, recurring } = req.body;
  if (!label || typeof amount !== 'number' || isNaN(amount) || amount < 0)
    return res.status(400).json({ error: 'label and non-negative amount required' });
  const all = loadJSON(EXPENSES_FILE, {});
  const key = recurring ? '_recurring' : req.params.month;
  if (!all[key]) all[key] = [];
  const entry = { id: crypto.randomUUID(), label: label.trim(), amount: parseFloat(amount.toFixed(2)) };
  all[key].push(entry);
  saveJSON(EXPENSES_FILE, all);
  res.json({ ...entry, recurring: Boolean(recurring) });
});

app.put('/api/expenses/:month/:id', (req, res) => {
  const { label, amount, recurring } = req.body;
  const all = loadJSON(EXPENSES_FILE, {});
  const id = req.params.id;
  const month = req.params.month;
  for (const key of ['_recurring', month]) {
    const entries = all[key] || [];
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) continue;
    const wasRecurring = key === '_recurring';
    const nowRecurring = recurring !== undefined ? Boolean(recurring) : wasRecurring;
    const updated = {
      ...entries[idx],
      ...(label  !== undefined ? { label:  label.trim() }                  : {}),
      ...(amount !== undefined ? { amount: parseFloat(amount.toFixed(2)) } : {}),
    };
    if (nowRecurring !== wasRecurring) {
      all[key] = entries.filter(e => e.id !== id);
      const newKey = nowRecurring ? '_recurring' : month;
      if (!all[newKey]) all[newKey] = [];
      all[newKey].push(updated);
    } else {
      entries[idx] = updated;
      all[key] = entries;
    }
    saveJSON(EXPENSES_FILE, all);
    return res.json({ ...updated, recurring: nowRecurring });
  }
  res.status(404).json({ error: 'Not found' });
});

app.delete('/api/expenses/:month/:id', (req, res) => {
  const all = loadJSON(EXPENSES_FILE, {});
  const id = req.params.id;
  for (const key of ['_recurring', req.params.month]) {
    const before = (all[key] || []).length;
    all[key] = (all[key] || []).filter(e => e.id !== id);
    if ((all[key] || []).length < before) { saveJSON(EXPENSES_FILE, all); return res.json({ success: true }); }
  }
  res.status(404).json({ error: 'Not found' });
});

// ---- Budget AI Insights ----
app.post('/api/budget/insights', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.json({ insight: null, noKey: true });

  const { month, totalSpent, monthlyBudget, categories, totalIncome, manualExpenses } = req.body;
  const client = new (getAnthropic())({ apiKey });

  const catLines = (categories || []).map(c => `  ${c.name}: $${c.spent.toFixed(0)}${c.budget ? ` (limit $${c.budget}, ${c.spent > c.budget ? 'OVER' : 'ok'})` : ''}`).join('\n');
  const expLines = (manualExpenses || []).map(e => `  ${e.label}: $${e.amount.toFixed(0)}`).join('\n');
  const [yr, mo] = (month || '').split('-');
  const monthLabel = yr && mo ? new Date(+yr, +mo - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' }) : month;
  const parts = [
    totalIncome      ? `Income: $${totalIncome.toFixed(0)}` : '',
    expLines         ? `Fixed expenses (rent, etc.):\n${expLines}` : '',
    `Credit card spending: $${totalSpent.toFixed(0)}`,
    monthlyBudget    ? `Monthly spend target: $${monthlyBudget}` : '',
    catLines         ? `Credit card breakdown:\n${catLines}` : '',
  ].filter(Boolean).join('\n');

  const systemPrompt = `Talk like a smart friend who knows money well — direct, warm, and specific. Use the actual dollar numbers. Skip filler like "Great job!" or "It's important to budget." If something looks good, just say so plainly. If something looks off, say exactly what and why. Give one concrete, specific thing they could do differently. 2-3 sentences max. No bullet points.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: `${systemPrompt}\n\n${monthLabel} finances:\n${parts}` }],
    });
    res.json({ insight: msg.content[0]?.text?.trim() || null });
  } catch (e) {
    res.json({ insight: null, error: e.message });
  }
});

app.post('/api/budgets/suggest', async (req, res) => {
  const transactions = loadJSON(TRANSACTIONS_FILE, []);
  if (!transactions.length) return res.json({ suggestions: {} });

  // Use all available months
  const relevant = transactions.filter(t => t.category && t.category !== 'Unknown' && t.date);
  if (!relevant.length) return res.json({ suggestions: {} });

  // Build per-category per-month totals
  const catByMonth = {};
  const allMonths = new Set();
  for (const t of relevant) {
    const m = t.date.slice(0, 7);
    allMonths.add(m);
    if (!catByMonth[t.category]) catByMonth[t.category] = {};
    catByMonth[t.category][m] = (catByMonth[t.category][m] || 0) + t.amount;
  }

  const numMonths = allMonths.size;
  const catSummary = {};
  for (const [cat, monthTotals] of Object.entries(catByMonth)) {
    const totals = Object.values(monthTotals);
    const avg = totals.reduce((s, a) => s + a, 0) / numMonths; // avg over all months (0 for months with no spend)
    const max = Math.max(...totals);
    catSummary[cat] = { avg: +avg.toFixed(0), max: +max.toFixed(0), months: totals.length };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    // Fall back to simple avg+10% rounded to $25
    const suggestions = {};
    for (const [cat, { avg }] of Object.entries(catSummary)) {
      suggestions[cat] = Math.ceil((avg * 1.1) / 25) * 25;
    }
    return res.json({ suggestions, aiUsed: false });
  }

  const client = new (getAnthropic())({ apiKey });
  const lines = Object.entries(catSummary)
    .map(([cat, { avg, max, months }]) => `${cat}: avg $${avg}/mo, max $${max}, present in ${months}/${numMonths} months`)
    .join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Based on spending history (${numMonths} months of data), suggest realistic monthly budget limits per category. Be slightly generous (a buffer above typical spend) but not wasteful. Round to nearest $25. Return ONLY valid JSON object like {"Groceries":400,"Dining":200}. Categories:\n${lines}`,
      }],
    });
    const raw = msg.content[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const aiSuggestions = JSON.parse(jsonMatch[0]);
    // Validate: only keep known categories with numeric values
    const suggestions = {};
    for (const [cat, val] of Object.entries(aiSuggestions)) {
      if (catSummary[cat] && typeof val === 'number' && val > 0) suggestions[cat] = val;
    }
    res.json({ suggestions, aiUsed: true });
  } catch (e) {
    // AI failed — fall back to simple avg
    const suggestions = {};
    for (const [cat, { avg }] of Object.entries(catSummary)) {
      suggestions[cat] = Math.ceil((avg * 1.1) / 25) * 25;
    }
    res.json({ suggestions, aiUsed: false });
  }
});

migrateToTitleCase();

app.get('/api/version', (_req, res) => {
  try { res.json({ version: require('./package.json').version || '0.0.0' }); }
  catch { res.json({ version: '0.0.0' }); }
});

const server = app.listen(PORT, () => {
  console.log(`\nPrism is running!`);
  console.log(`Open http://localhost:${PORT} in your browser`);
  console.log(`Close this window to quit.\n`);

  if (isPkg) {
    const { exec } = require('child_process');
    setTimeout(() => exec(`start http://localhost:${PORT}`), 600);
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`Close any other Prism window and try again.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
