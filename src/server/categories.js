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
  [/walmart|wal.mart|whole\s*food|wholefds|kroger|safeway|trader\s*joe|publix|aldi|costco|sam.s\s*club|wegmans|meijer|food\s*lion|stop\s*&?\s*shop|harris\s*teeter|sprouts|fresh\s*market|\bheb\b|winco|piggly|grocery|supermarket|market\s*basket|price\s*chopper|giant\s*food|winn.?dixie|save.?a.?lot|lidl|albertsons|vons|ralphs|smiths\s*food|fred\s*meyer|fry.s\s*food|instacart|shipt\b|fresh\s*direct|peapod|shufersal|rami\s*levy|osher\s*ad|yochananof|victory\s*market/i, 'Groceries'],
  // Dining & Restaurants — word boundaries on generic terms
  [/mcdonald|burger\s*king|wendy.s|taco\s*bell|chick.fil|subway|domino.s|pizza\s*hut|papa\s*john|chipotle|panera|starbucks|dunkin|krispy\s*kreme|five\s*guys|shake\s*shack|sonic\s*drive|arby.s|\bkfc\b|popeye|olive\s*garden|applebee|chili.s|outback|cheesecake\s*factory|\bihop\b|denny.s|waffle\s*house|cracker\s*barrel|grubhub|doordash|uber\s*eat|postmates|seamless|sweetgreen|cava\b|wingstop|raising\s*cane|culver.s|whataburger|jack\s*in\s*the\s*box|del\s*taco|carl.s\s*jr|hardee.s|cook\s*out|steak\s*.n.\s*shake|white\s*castle|checkers|rally.s|panda\s*express|jersey\s*mike|jimmy\s*john|firehouse\s*sub|noodles\s*&?\s*co|habit\s*burger|smashburger|portillo|golden\s*corral|texas\s*roadhouse|longhorn\s*steak|red\s*lobster|buffalo\s*wild|bww\b|yard\s*house|perkins|ihop|aroma\s*espresso|cafe\s*cafe|landwer|\bcofix\b|arcaffe|\bcaffit\b|\bfalafel\b|\bhummus\b|\bshwarma\b|\bcafe\b|\bbistro\b|\bgrill\b|\bbbq\b|\bdiner\b|\beatery\b|\btaqueria\b|\bnoodle\b|sushi|ramen|burritos|\bwing\b|pizza(?!\s*hut)/i, 'Dining & Restaurants'],
  // Gas & Fuel
  [/\bshell\b|exxon|\bmobil\b|\bbp\b|chevron|speedway|circle\s*k|wawa|sheetz|sunoco|marathon\s*gas|valero|casey.s|quiktrip|\bqt\b|pilot\s*flying|flying\s*j|love.s\s*travel|racetrac|kwik\s*trip|kwik\s*star|murphy\s*usa|holiday\s*station|\bgas\s*station\b|\bfuel\b|\bpaz\b|\bdelek\b|\bsonol\b/i, 'Gas & Fuel'],
  // Subscriptions & Streaming — before Shopping so apple/google hits here first
  [/netflix|spotify|hulu|disney\s*\+?|\badobe\b|elevenlabs|anthropic|\bclaude\b|openai|chatgpt|midjourney|\bcanva\b|grammarly|1password|nordvpn|expressvpn|icloud|google\s*one|microsoft\s*365|office\s*365|hbo\s*max|\bmax\b.*stream|apple\s*tv\+?|amazon\s*prime(?!\s*(now|fresh))|youtube\s*premium|peacock|paramount\+?|apple\.com\/bill|itunes|google\s*play|microsoft\s*store|nintendo\s*eshop|playstation\s*store|xbox\s*game|twitch|amc\+|shudder|criterion|curiosity\s*stream|discovery\+|espn\+|sling\s*tv|fubo|philo|starz|showtime\s*anytime|mubi|crunchyroll|sirius\s*xm|pandora\s*plus|tidal\b|audible|kindle\s*unlimited|scribd|duolingo\s*plus/i, 'Subscriptions & Streaming'],
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

// Israeli chains and services, as they appear transliterated on statements
const ISRAEL_RULES = [
  [/shufersal|shufersall|rami\s*lev[iy]|yochananof|yohananof|osher\s*ad|hatzi\s*hinam|hazi\s*hinam|ma[ch]+sanei\s*hashuk|yeinot\s*bitan|\bbitan\b|tiv\s*taam|\bmega\s*(ba|bair|kol)?\b|carrefour|super\s*yuda|freshmarket|zol\s*be?gadol|mahane\s*yehuda|king\s*store|kingstore|super\s*sal\b|\bam\s*:?\s*pm\b|\bampm\b|hamakolet|makolet|super\s*dosh|kosher\s*(market|mart)|\bglatt\b|mayan\s*2000|ma[ch]+san[iy]+\s*ha?sh[au]+k|ma'?adan|\bkolbo\b|supersal/i, 'Groceries'],
  [/\baroma\b|\bcofix\b|landwer|cafe\s*cafe|\bgreg\b|arcaffe|caffit|roladin|\bgolda\b|vaniglia|burgerim|burger\s*saloon|\bmoses\b|\bbbb\b|japanika|\bgiraffe\b|\bwolt\b|\b10\s*bis\b|ten\s*bis|tenbis|\bcibus\b|shipudei|shipudim|hummus|humus|falafel|shawarma|shwarma|sabich|hamitbach|meshek|piece\s*of\s*cake|angel\s*bakery|nechama|biscotti|max\s*brenner|coffee\s*bean|cafe\s*joe|joe\s*cafe|leggenda|\banita\b|gelato|glida|pizza\s*hut|dominos|mcdonald|\bkfc\b|burger\s*king|pinati|pundak|steakiya|misada|mis'ada|bistro|\bbar\s*giyora|\bport\s*said\b|susu|taizu|yaffo|abu\s*hassan|ima\b.*rest|shakshuk|shkshok|sabi[ch]+\b|\bpita\b|pizuh|maafi|maafiya/i, 'Dining & Restaurants'],
  [/\bpaz\b|\bdelek\b|\bsonol\b|dor\s*alon|\balon\s*(gas|fuel|station)|\bten\s*(gas|fuel|station)|\byellow\b|\bmenta\b|so\s*good\b|dalkan|pazomat|tzomet\s*(gas|delek)/i, 'Gas & Fuel'],
  [/\begged\b|\bdan\s*(bus|north|south|transport)|\bkavim\b|metropoline|nateev|superbus|rav[\s-]*kav|ravkav|getyourguide|\bviator\b|\bklook\b|rakevet|israel\s*rail|\brail\b|\bgett\b|\byango\b|moovit|\bbolt\b|\bgrab\b|grabtaxi|bubble\s*dan|tel-?o-?fun|carmelit|light\s*rail|\bpango\b|cellopark|ahuzot\s*ha?hof|ahuzot|\bel\s*al\b|\belal\b|israir|\barkia\b|ben\s*gurion|natbag|kavei|taxi|monit|\bbus\b|\bparking\b|\bhanaya\b|\bhania\b/i, 'Travel & Transport'],
  [/super-?\s*pharm|superpharm|be\s*pharm|good\s*pharm|new-?\s*pharm|meuhedet|mecuhedet|meuhdet|maccabi|macabi|clalit|leumit|assuta|hadassah|ichilov|\bsheba\b|tel\s*hashomer|shaare\s*zedek|shaarei\s*tzedek|\bterem\b|bikur\s*(rofe|holim)|kupat\s*holim|\bpharm\b|optics?|optica|opticana|halperin|carolina\s*lemke|\bdr\.?\s|rofe|shinayim|dental|\bmirpaa|mirpa'a|physio|fizio|beit\s*merkahat|merkahat/i, 'Health & Medical'],
  [/\bbezeq\b|\bpartner\b|cellcom|pelephone|tripletel|we4g|\bhot\b|hot\s*mobile|\byes\b|golan\s*telecom|\bgolan\b|\b01[2-9]\b|rami\s*levy\s*(com|tik)|hevrat\s*ha?shmal|\biec\b|israel\s*electric|electric\s*corp|mekorot|mei\s*(avivim|carmel|shikma|raanana|netanya|ashkelon)|\bmei\b|water\s*corp|hagihon|gihon|arnona|iriya|iriyat|municipal|vaad\s*ba?yit|va'ad|supergas|amisragas|pazgas|bituach|\bharel\b|\bmigdal\b|\bclal\b|phoenix|menora|ayalon\s*(ins|bit)|shirbit|\blibra\b|\bwobi\b|9\s*million|insurance/i, 'Utilities & Bills'],
  [/\bcastro\b|\bfox\b|\bgolf\b|renuar|h\s*&\s*m|\bzara\b|terminal\s*x|\badika\b|\bshein\b|\bnext\b|american\s*eagle|\bivory\b|\bksp\b|\bbug\b|ma[ch]+sanei\s*hashmal|electric\s*shop|hamashbir|mashbir|azrieli|dizengoff\s*center|big\s*fashion|\bbig\b|grand\s*canyon|ramat\s*aviv\s*mall|kenyon|kanyon|canyon|toys\s*r\s*us|\bace\b|home\s*center|max\s*stock|maxstock|shilav|super\s*baby|st[ei]+matzk[iy]|king\s*power|duty\s*free|superpram|t[sz]omet\s*sfarim|\bikea\b|nespresso|weshoes|\bscoop\b|\baldo\b|nine\s*west|\bjump\b|\btimberland\b|\bcolumbia\b|\bnike\b|\badidas\b|decathlon|\blord\s*kitsch|kitsch|honigman|twentyfourseven|24\/7|\bhoodies\b|\bpull\s*&\s*bear|bershka|mango\b|\bgap\b|office\s*depot|\bstematsky/i, 'Shopping'],
  [/laline|\bsabon\b|kiehl|mac\s*cosmetics|mispara|barber|salon|pedicure|manicure|\blash\b|\bbrow\b|hair\s*(salon|studio)|cosmetic|kosmetik|\bspa\b/i, 'Personal Care'],
  [/\bmahon\b|yeshiva|yeshivat|\bkollel\b|beit\s*sefer|\bschool\b|universit|technion|bar\s*ilan|\bhebrew\s*u|weizmann|ben\s*gurion\s*u|ariel\s*u|open\s*u|college|michlala|michlelet|\bulpan\b|\b[ch]ugim\b|\bhug\b|tutor|matnas|community\s*center|\bgan\s*(yeladim|hova|trom)|\bmaon\b|\bpeuton|tzaharon|tsaharon/i, 'Education'],
  [/tzedak|zedaka|\bgemach\b|charity|\bamuta|\bamutat|yad\s*sarah|yad\s*eliezer|ezer\s*mizion|\blatet\b|\bleket\b|paamonim|chabad\s*(house|of|lubavitch)|beit\s*chabad|colel\s*chabad|kupat\s*ha'?ir|vaad\s*harabanim|hachnasat\s*kal|donation|\bmatan\b|\bjnf\b|keren\s*kayemet|magen\s*david|\bmda\b|zaka|united\s*hatzalah|hatzalah|hatzolah|meir\s*panim|colel\s*chabad|\bshul\b|synagogue|beit\s*knesset|\bkehila|kehilat/i, 'Gifts & Donations'],
  [/cinema\s*city|yes\s*planet|hot\s*cinema|rav\s*hen|lev\s*cinema|\bglobus\b|cinemall|luna\s*park|superland|jump\s*park|escape\s*room|\bzappa\b|\bbarby\b|hangar\s*11|caesarea\s*amph|eventim|\bleaan\b|\bbravo\b|habima|cameri|beit\s*lessin|tzavta|israel\s*museum|tower\s*of\s*david|\bsafari\b|biblical\s*zoo|\bzoo\b|hamat\s*gader|yamit\s*2000|meymadion|kids\s*club|\bpark\s*(ha|hamaim|hayarkon)|tickets?\b|\bmuseum|\bteatron|theatre|theater|\bkolnoa/i, 'Entertainment'],
];

// Generic words that identify a business type when no brand rule matched.
// Whole words only, checked after brand rules so "AMAZON MARKETPLACE" is
// Shopping, not Groceries.
const GENERIC_RULES = [
  [/\b(pizza|pizzeria|cafe|caf[eé]|coffee|espresso|bakery|bagels?|deli|restaurant|ristorante|bistro|grill|grille|kitchen|diner|eatery|tavern|pub|brewing|brewery|taproom|sushi|ramen|noodle|taco|tacos|taqueria|burger|burgers|wings|steakhouse|bbq|barbecue|chicken|kebab|falafel|shawarma|shwarma|hummus|creamery|donuts?|doughnuts?|smoothie|juice|boba|tea\s*house|teahouse|catering|caterers|food\s*truck|cantina|trattoria|osteria|brasserie|gastropub|cookies|cupcakes?|frozen\s*yogurt|froyo|gelato|ice\s*cream)\b/i, 'Dining & Restaurants'],
  [/\b(grocery|grocer|groceries|supermarket|super\s*market|market|markets|foods|farms?|produce|butcher|fish\s*market|seafood\s*market|organic|natural\s*foods|co-?op|bodega|convenience|mini\s*mart|minimart|food\s*mart|quick\s*stop|liquor|liquors|wine\s*(&|and)\s*spirits|wines?\s*shop|beverage)\b/i, 'Groceries'],
  [/\b(gas|fuel|petrol|petroleum|gasoline|service\s*station|filling\s*station|ev\s*charg\w*|supercharger|chargepoint|electrify\s*america|evgo|blink\s*charg)\b/i, 'Gas & Fuel'],
  [/\b(pharmacy|pharma|drug\s*store|drugstore|apothecary|clinic|clinics|dental|dentist|dentistry|orthodont\w*|medical|physician|physicians|hospital|urgent\s*care|pediatric\w*|dermatolog\w*|optometr\w*|ophthalmolog\w*|optical|eyecare|eye\s*care|vision|lab|labs|laborator\w*|imaging|radiology|physical\s*therapy|physio\w*|chiropract\w*|acupunctur\w*|psycholog\w*|therapist|therapy|counseling|wellness|health|healthcare|fitness|gym|crossfit|pilates|yoga|barre|athletic\s*club|vet|veterinar\w*|animal\s*hospital)\b/i, 'Health & Medical'],
  [/\b(parking|garage|park\s*(n|and|&)\s*(ride|fly)|toll|tolls|tollway|turnpike|transit|metro|subway\s*(card|fare)|railroad|railway|rail|amtrak|bus|coach|shuttle|taxi|cab|limo|limousine|rideshare|airline|airlines|airways|airport|flight|flights|hotel|hotels|inn|motel|resort|lodge|hostel|suites|car\s*rental|rent-?a-?car|rental\s*car|cruise|cruises|travel|tours?|vacation|ferry)\b/i, 'Travel & Transport'],
  [/\b(salon|salons|barber|barbers|barbershop|nails?|nail\s*spa|spa|day\s*spa|beauty|cosmetics|skincare|skin\s*care|esthetic\w*|aesthetic\w*|massage|waxing|wax|lash|lashes|brows?|tanning|tattoo|piercing|grooming|hair)\b/i, 'Personal Care'],
  [/\b(hardware|lumber|garden\s*center|nursery|landscap\w*|lawn|plumbing|plumber|electrician|electrical|hvac|heating|cooling|roofing|painting|painter|contractor|contractors|handyman|home\s*improvement|flooring|carpet|tile|kitchens?\s*(&|and)\s*baths?|cabinets?|blinds|windows?\s*(&|and)\s*doors?|appliance|appliances|furniture|mattress|lighting|pest\s*control|exterminat\w*|cleaning\s*service|maid|housekeeping|storage|self\s*storage|moving|movers)\b/i, 'Home & Garden'],
  [/\b(school|schools|academy|university|college|institute|tuition|tutor|tutoring|lessons?|classes|course|courses|training|learning|education|educational|preschool|pre-?k|daycare|day\s*care|childcare|child\s*care|nursery\s*school|kindergarten|camp|summer\s*camp|yeshiva|seminary|beis|beit\s*sefer|montessori|library|bookstore|textbooks?)\b/i, 'Education'],
  [/\b(charity|charities|charitable|foundation|donation|donations|donate|fund|fundrais\w*|nonprofit|non-?profit|ministry|ministries|church|temple|synagogue|shul|congregation|mosque|parish|mission|missions|relief|red\s*cross|salvation\s*army|goodwill|scholarship|memorial|tzedak\w*|gemach|florist|flowers?|gift\s*shop|gifts?|cards?\s*(&|and)\s*gifts?|greeting)\b/i, 'Gifts & Donations'],
  [/\b(insurance|insurer|assurance|electric|electricity|power\s*(co|company|corp)|energy|utility|utilities|water\s*(co|company|dept|department|district|works|authority)|sewer|sanitation|waste|trash|recycling|internet|broadband|cable|telecom|telecommunications|wireless|mobile|cellular|phone\s*(co|company|bill)|telephone|dmv|registration|license|permit|tax|taxes|irs|treasury|city\s*of|county\s*of|town\s*of|village\s*of|municipal|court|fine|fines|ticket\s*payment|hoa|homeowners|rent|rental\s*payment|mortgage|loan\s*payment|tolls?\s*by\s*mail)\b/i, 'Utilities & Bills'],
  [/\b(cinema|cinemas|theatre|theater|theaters|movies?|film|films|imax|concert|concerts|tickets?|ticketing|box\s*office|museum|museums|gallery|zoo|aquarium|arcade|bowling|billiards|golf|mini\s*golf|skating|ice\s*rink|trampoline|escape\s*room|amusement|theme\s*park|water\s*park|carnival|fair|festival|club|nightclub|lounge|karaoke|comedy|stadium|arena|sports\s*bar|games?|gaming|playstation|xbox|nintendo|steam|twitch|entertainment)\b/i, 'Entertainment'],
  [/\b(store|stores|shop|shops|shopping|boutique|outlet|outlets|mall|plaza|department\s*store|clothing|clothes|apparel|fashion|footwear|shoes?|sneakers?|jewelry|jewelers?|watch|watches|eyewear|sunglasses|electronics|computers?|tech|gadgets?|phone\s*(store|shop|repair)|toys?|games?\s*(&|and)\s*toys|hobby|crafts?|fabric|books?|comics?|music\s*(store|shop)|records?|vinyl|sporting\s*goods|sports\s*(store|shop)|outdoor|bike\s*shop|cycles?|pets?|pet\s*(store|shop|supply|supplies)|petco|petsmart|dollar|discount|thrift|vintage|antiques?|consignment|wholesale|warehouse|supply|supplies|office\s*supplies|stationery|party\s*(city|store|supply)|costume|florist|nursery|garden\s*shop|home\s*goods|housewares|kitchenware|bed\s*(&|and)\s*bath|bath\s*(&|and)\s*body|candles?|perfume|fragrance|luggage|bags?|leather|tailor|alterations|dry\s*clean\w*|laundromat|laundry|cleaners)\b/i, 'Shopping'],
  [/\b(consulting|consultant|consultants|law|legal|attorney|attorneys|lawyer|lawyers|esq|accounting|accountant|accountants|cpa|bookkeeping|tax\s*prep\w*|notary|printing|print\s*shop|copies|copy\s*center|shipping|postage|postal|courier|freight|logistics|coworking|co-?working|office\s*space|domain|hosting|software|saas|cloud|server|servers|payroll|invoice|invoicing|advertising|marketing|seo|web\s*design|studio\s*rental|equipment\s*rental)\b/i, 'Business Expenses'],
];

function matchRules(rules, name) {
  for (const [pattern, category] of rules) if (pattern.test(name)) return category;
  return null;
}

// Brand rules: US first, then Israeli
function autoCategory(merchant) {
  return matchRules(AUTO_RULES, merchant) || matchRules(ISRAEL_RULES, merchant);
}

// Business-type words, for names no brand rule knows
function genericCategory(merchant) {
  return matchRules(GENERIC_RULES, merchant);
}

// ---- Fuzzy merchant memory ----
// "Starbucks Store" should get whatever the user chose for "Starbucks".
const simpleKey = name => String(name).toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();

function findSimilarMerchant(name, merchants) {
  const key = simpleKey(name);
  if (key.length < 5) return null;
  let best = null;
  for (const [known, category] of Object.entries(merchants)) {
    if (!category) continue;
    const k = simpleKey(known);
    if (k.length < 5) continue;
    if (k === key) return { merchant: known, category, score: 1 };
    const [short, long] = k.length <= key.length ? [k, key] : [key, k];
    // One is the other plus extra words: "starbucks" / "starbucks store", "amazon" / "amazon mktpl"
    if (long.startsWith(short + ' ') && short.length >= 6) {
      const score = 0.6 + 0.3 * (short.length / long.length);
      if (!best || score > best.score) best = { merchant: known, category, score };
    }
  }
  return best;
}

// ---- Free-text description → category ("gas", "lunch with a client") ----
const DESCRIPTION_RULES = [
  [/\b(grocer\w*|supermarket|super\s*market|market|produce|butcher|kosher|food\s*shop\w*|weekly\s*shop\w*|shuk|makolet)\b/i, 'Groceries'],
  [/\b(restaurant|dinner|lunch|breakfast|brunch|food|meal|eat|ate|eating|takeout|take-?out|takeaway|delivery|cafe|coffee|latte|pizza|sushi|burger|drinks?|beer|bar|pub|bakery|dessert|snack|snacks|ice\s*cream|wolt|10bis|doordash|uber\s*eats)\b/i, 'Dining & Restaurants'],
  [/\b(gas|gasoline|fuel|petrol|diesel|charging|ev|paz|delek|sonol)\b/i, 'Gas & Fuel'],
  [/\b(uber|lyft|taxi|cab|gett|bus|train|subway|metro|rail|flight|flights|plane|airline|airfare|hotel|airbnb|parking|toll|tolls|rental\s*car|car\s*rental|travel|trip|vacation|commute|transit|rav\s*kav)\b/i, 'Travel & Transport'],
  [/\b(doctor|dr|dentist|dental|pharmacy|prescription|meds?|medicine|medical|hospital|clinic|therapy|therapist|gym|fitness|workout|vitamins?|glasses|contacts|copay|co-?pay|health|kupat\s*holim|maccabi|clalit|meuhedet)\b/i, 'Health & Medical'],
  [/\b(electric\w*|water|utility|utilities|internet|wifi|phone|cell|mobile|bill|bills|insurance|rent|arnona|vaad|hoa|gas\s*bill|cable|bezeq|cellcom|partner|hot|yes)\b/i, 'Utilities & Bills'],
  [/\b(netflix|spotify|subscription|subscriptions|streaming|hulu|disney|hbo|apple\s*(music|tv|one)|youtube|icloud|google\s*(one|storage)|chatgpt|openai|software|app|membership)\b/i, 'Subscriptions & Streaming'],
  [/\b(haircut|hair|barber|salon|nails?|manicure|pedicure|spa|massage|beauty|cosmetics|skincare|waxing|laser)\b/i, 'Personal Care'],
  [/\b(home|house|garden|furniture|hardware|repair|repairs|plumber|electrician|renovation|cleaning|cleaner|ikea|home\s*depot|appliance|decor|tools?)\b/i, 'Home & Garden'],
  [/\b(school|tuition|class|classes|course|courses|lesson|lessons|tutor|tutoring|books?|textbook|university|college|daycare|preschool|kindergarten|gan|camp|education|learning)\b/i, 'Education'],
  [/\b(gift|gifts|present|presents|donation|donate|charity|tzedaka|tzedakah|wedding|birthday|flowers?|shul|synagogue|church)\b/i, 'Gifts & Donations'],
  [/\b(work|business|client|clients|office|invoice|software|hosting|domain|aws|cloud|conference|expense|reimburs\w*|freelance|consulting)\b/i, 'Business Expenses'],
  [/\b(movie|movies|cinema|theater|theatre|concert|show|tickets?|game|games|gaming|museum|zoo|park|bowling|fun|night\s*out|entertainment|hobby|hobbies|steam|playstation|xbox)\b/i, 'Entertainment'],
  [/\b(clothes|clothing|shirt|shoes|sneakers|jeans|dress|amazon|shopping|store|shop|order|online|electronics|phone\s*case|headphones|gadget|toy|toys|kids?\s*stuff|baby|diapers)\b/i, 'Shopping'],
];

function categoryFromDescription(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  return matchRules(DESCRIPTION_RULES, t) || autoCategory(t) || genericCategory(t);
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
  GENERAL_SERVICES_CHILDCARE: 'Education',
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: 'Shopping',
  MEDICAL_VETERINARY_SERVICES: 'Health & Medical',
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

// Plaid's primary categories, longest first so "GENERAL_MERCHANDISE_..." isn't read as "GENERAL"
const PLAID_PRIMARIES = ['GOVERNMENT_AND_NON_PROFIT', 'GENERAL_MERCHANDISE', 'RENT_AND_UTILITIES', 'HOME_IMPROVEMENT', 'GENERAL_SERVICES',
  'FOOD_AND_DRINK', 'LOAN_PAYMENTS', 'TRANSPORTATION', 'ENTERTAINMENT', 'PERSONAL_CARE', 'TRANSFER_OUT', 'TRANSFER_IN', 'BANK_FEES',
  'MEDICAL', 'TRAVEL', 'INCOME', 'OTHER'];
function plaidPrimary(detailed) {
  const d = String(detailed || '');
  return PLAID_PRIMARIES.find(p => d === p || d.startsWith(p + '_')) || '';
}

// Accepts Plaid's { primary, detailed } object or just the detailed code
function mapPlaidCategory(pfc) {
  if (!pfc) return null;
  const detailed = typeof pfc === 'string' ? pfc : pfc.detailed;
  const primary = typeof pfc === 'string' ? plaidPrimary(pfc) : (pfc.primary || plaidPrimary(detailed));
  return PLAID_CATEGORY_MAP[detailed] || PLAID_CATEGORY_MAP[primary] || null;
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

// Money the card issuer put back that isn't a merchant refund: rewards,
// statement credits, interest adjustments. Only ever applies to credits.
const CARD_CREDIT_RE = /\b(credit|reward|rewards|cash\s*back|cashback|statement|adjustment|adj|interest|rebate|bonus|promo|courtesy|redemption|paze)\b/i;
function isCardCredit(name, amount, plaidCategory = '') {
  if (!(amount < 0)) return false;
  const primary = plaidPrimary(plaidCategory);
  if (['LOAN_PAYMENTS', 'TRANSFER_IN', 'TRANSFER_OUT', 'BANK_FEES', 'INCOME'].includes(primary)) return true;
  return CARD_CREDIT_RE.test(String(name || ''));
}

module.exports = {
  CATEGORIES, HIGH_CONFIDENCE, LOW_CONFIDENCE,
  AUTO_RULES, ISRAEL_RULES, GENERIC_RULES, DESCRIPTION_RULES,
  autoCategory, genericCategory, findSimilarMerchant, categoryFromDescription, simpleKey,
  mapBankCategory, mapPlaidCategory, plaidPrimary,
  PAYMENT_RE, PLAID_PAYMENT_RE, isPayment, isCardCredit,
};
