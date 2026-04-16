// 50 seed apps - iTunes Search APIでApple IDを自動取得
const SEED_APPS = [
  // Productivity (10)
  { name: "Microsoft Outlook", category: "Productivity", tags: ["email","calendar","office","microsoft"] },
  { name: "Google Calendar", category: "Productivity", tags: ["calendar","schedule","google"] },
  { name: "Notion", category: "Productivity", tags: ["notes","pdf","wiki","database","documents","project"] },
  { name: "Todoist", category: "Productivity", tags: ["todo","tasks","reminders","productivity"] },
  { name: "Evernote", category: "Productivity", tags: ["notes","pdf","documents","scan","organizer"] },
  { name: "Microsoft Teams", category: "Productivity", tags: ["chat","video","meetings","microsoft","collaboration"] },
  { name: "Slack", category: "Productivity", tags: ["chat","messaging","team","collaboration","channels"] },
  { name: "Trello", category: "Productivity", tags: ["kanban","boards","project","tasks"] },
  { name: "Google Sheets", category: "Productivity", tags: ["spreadsheet","data","google","office"] },
  { name: "Asana", category: "Productivity", tags: ["project","tasks","team","workflow"] },
  // Social (8)
  { name: "Threads", category: "Social", tags: ["social","microblog","text","instagram"] },
  { name: "Facebook", category: "Social", tags: ["social","friends","groups","marketplace"] },
  { name: "Instagram", category: "Social", tags: ["photos","stories","reels","social"] },
  { name: "Snapchat", category: "Social", tags: ["messaging","photos","stories","AR"] },
  { name: "LinkedIn", category: "Social", tags: ["professional","networking","jobs","career"] },
  { name: "Reddit", category: "Social", tags: ["forums","communities","discussion","news"] },
  { name: "X", category: "Social", tags: ["microblog","news","social","trending"] },
  { name: "Discord", category: "Social", tags: ["chat","voice","gaming","communities","servers"] },
  // Health & Fitness (7)
  { name: "MyFitnessPal", category: "Health & Fitness", tags: ["calories","diet","nutrition","food tracking"] },
  { name: "Noom", category: "Health & Fitness", tags: ["weight loss","coaching","diet","health"] },
  { name: "Strava", category: "Health & Fitness", tags: ["running","cycling","GPS","fitness tracking"] },
  { name: "Peloton", category: "Health & Fitness", tags: ["workout","cycling","fitness","classes"] },
  { name: "Fitbit", category: "Health & Fitness", tags: ["fitness tracking","steps","sleep","health"] },
  { name: "Headspace", category: "Health & Fitness", tags: ["meditation","mindfulness","sleep","mental health"] },
  { name: "Calm", category: "Health & Fitness", tags: ["meditation","sleep","relaxation","mental health"] },
  // Finance (6)
  { name: "Credit Karma", category: "Finance", tags: ["credit score","finance","loans","monitoring"] },
  { name: "Robinhood", category: "Finance", tags: ["stocks","investing","trading","crypto"] },
  { name: "Venmo", category: "Finance", tags: ["payments","money transfer","split bills","social"] },
  { name: "Cash App", category: "Finance", tags: ["payments","money transfer","bitcoin","banking"] },
  { name: "PayPal", category: "Finance", tags: ["payments","money transfer","online shopping"] },
  { name: "YNAB", category: "Finance", tags: ["budgeting","finance","money management","savings"] },
  // Entertainment (5)
  { name: "Netflix", category: "Entertainment", tags: ["streaming","movies","TV shows","video"] },
  { name: "Spotify", category: "Entertainment", tags: ["music","streaming","podcasts","playlists"] },
  { name: "YouTube", category: "Entertainment", tags: ["video","streaming","creators","music"] },
  { name: "Max", category: "Entertainment", tags: ["streaming","movies","TV shows","HBO"] },
  { name: "Hulu", category: "Entertainment", tags: ["streaming","movies","TV shows","live TV"] },
  // Education (4)
  { name: "Duolingo", category: "Education", tags: ["language learning","flashcards","education","games"] },
  { name: "Coursera", category: "Education", tags: ["online courses","university","certificates","learning"] },
  { name: "Khan Academy", category: "Education", tags: ["education","math","science","free learning"] },
  { name: "Anki", category: "Education", tags: ["flashcards","spaced repetition","study","memorization"] },
  // Travel (4)
  { name: "Google Maps", category: "Travel", tags: ["maps","navigation","directions","GPS","local"] },
  { name: "Uber", category: "Travel", tags: ["ride sharing","taxi","transportation"] },
  { name: "Airbnb", category: "Travel", tags: ["accommodation","vacation rental","travel","hosting"] },
  { name: "Booking.com", category: "Travel", tags: ["hotels","accommodation","travel","reservations"] },
  // Food & Drink (4)
  { name: "DoorDash", category: "Food & Drink", tags: ["food delivery","restaurants","takeout"] },
  { name: "Uber Eats", category: "Food & Drink", tags: ["food delivery","restaurants","takeout"] },
  { name: "Starbucks", category: "Food & Drink", tags: ["coffee","ordering","rewards","loyalty"] },
  { name: "Instacart", category: "Food & Drink", tags: ["grocery delivery","shopping","food"] },
  // Shopping (3)
  { name: "Amazon", category: "Shopping", tags: ["shopping","ecommerce","delivery","marketplace"] },
  { name: "Temu", category: "Shopping", tags: ["shopping","ecommerce","deals","discount"] },
  { name: "Walmart", category: "Shopping", tags: ["shopping","grocery","retail","pickup"] },
  // Utilities (3)
  { name: "Truecaller", category: "Utilities", tags: ["caller ID","spam blocking","phone","contacts"] },
  { name: "The Weather Channel", category: "Utilities", tags: ["weather","forecast","radar","alerts"] },
  { name: "Files by Google", category: "Utilities", tags: ["file manager","storage","cleanup","google"] },
];

// iTunes Search APIでApple IDを取得
async function lookupAppleId(appName) {
  const query = encodeURIComponent(appName);
  const url = `https://itunes.apple.com/search?term=${query}&media=software&country=us&limit=5`;
  
  try {
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.results && data.results.length > 0) {
      // 最も名前が近いものを選ぶ
      const match = data.results.find(r => 
        r.trackName.toLowerCase().includes(appName.toLowerCase().split(' ')[0].toLowerCase())
      ) || data.results[0];
      
      return {
        appleId: String(match.trackId),
        actualName: match.trackName,
        iconUrl: match.artworkUrl100,
        averageRating: match.averageUserRating || null,
        totalRatings: match.userRatingCount || null,
      };
    }
    return null;
  } catch (err) {
    console.error(`  Error looking up "${appName}":`, err.message);
    return null;
  }
}

// メイン処理
async function main() {
  console.log('🔍 Fetching Apple IDs for 50 seed apps...\n');
  
  const results = [];
  let found = 0;
  let notFound = 0;

  for (let i = 0; i < SEED_APPS.length; i++) {
    const app = SEED_APPS[i];
    process.stdout.write(`  [${i + 1}/50] ${app.name}... `);
    
    const info = await lookupAppleId(app.name);
    
    if (info) {
      results.push({ ...app, ...info });
      console.log(`✅ ${info.actualName} (ID: ${info.appleId})`);
      found++;
    } else {
      console.log('❌ Not found');
      notFound++;
    }
    
    // Rate limit: 1.5秒待機（20 calls/min制限対策）
    if (i < SEED_APPS.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`\n📊 Results: ${found} found, ${notFound} not found\n`);

  // SQL INSERT文を生成
  let sql = '-- GapSpark Seed Data: 50 Tracked Apps\n';
  sql += '-- Auto-generated from iTunes Search API\n\n';

  for (const app of results) {
    const tags = JSON.stringify(app.tags).replace(/'/g, "''");
    const name = app.actualName.replace(/'/g, "''");
    const iconUrl = (app.iconUrl || '').replace(/'/g, "''");
    const avgRating = app.averageRating !== null ? app.averageRating : 'NULL';
    const totalRatings = app.totalRatings !== null ? app.totalRatings : 'NULL';

    sql += `INSERT OR IGNORE INTO tracked_apps (apple_id, app_name, category, tags, icon_url, average_rating, total_ratings)\n`;
    sql += `VALUES ('${app.appleId}', '${name}', '${app.category}', '${tags}', '${iconUrl}', ${avgRating}, ${totalRatings});\n\n`;
  }

  // SQLファイルに保存
  const fs = await import('fs');
  fs.writeFileSync('seed-data.sql', sql);
  console.log('💾 Saved to seed-data.sql');
  console.log('');
  console.log('Next step: Run this command to insert into D1:');
  console.log('  npx wrangler d1 execute gapspark-db --remote --file=./seed-data.sql');
}

main();
