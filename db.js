require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(20) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT NOW(),
      banned BOOLEAN DEFAULT false,
      ban_reason TEXT,
      avatar_color VARCHAR(20) DEFAULT '#c0392b',
      bio TEXT DEFAULT '',
      coins INTEGER DEFAULT 200,
      last_daily TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      type VARCHAR(20),
      class VARCHAR(20),
      hp INTEGER,
      atk INTEGER,
      def INTEGER,
      spd INTEGER,
      ability_name VARCHAR(100),
      ability_desc TEXT,
      ability_power INTEGER,
      retreat_cost INTEGER,
      weakness VARCHAR(20),
      resistance VARCHAR(20),
      rarity VARCHAR(20),
      is_parallel BOOLEAN DEFAULT false,
      is_numbered BOOLEAN DEFAULT false,
      card_number VARCHAR(20),
      print_run INTEGER,
      set_name VARCHAR(50),
      flavor_text TEXT,
      art_style VARCHAR(20)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_cards (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER REFERENCES cards(id),
      quantity INTEGER DEFAULT 1,
      obtained_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, card_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      friend_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, friend_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      player1_id INTEGER REFERENCES users(id),
      player2_id INTEGER,
      winner_id INTEGER,
      p1_hp_left INTEGER DEFAULT 0,
      p2_hp_left INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      match_log JSONB DEFAULT '[]'
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      reporter_id INTEGER REFERENCES users(id),
      reported_user_id INTEGER REFERENCES users(id),
      category VARCHAR(30),
      description TEXT,
      status VARCHAR(20) DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      handled_by INTEGER REFERENCES users(id),
      handler_notes TEXT
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme VARCHAR(20) DEFAULT 'default',
      show_collection BOOLEAN DEFAULT true,
      show_rank BOOLEAN DEFAULT true,
      notifications BOOLEAN DEFAULT true,
      privacy_level VARCHAR(20) DEFAULT 'public'
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS ranked_stats (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      rating INTEGER DEFAULT 1000,
      season_wins INTEGER DEFAULT 0,
      season_losses INTEGER DEFAULT 0,
      rank_title VARCHAR(30) DEFAULT 'Bronze',
      top500 BOOLEAN DEFAULT false
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(40) NOT NULL,
      message TEXT NOT NULL,
      from_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      read BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES users(id),
      action VARCHAR(100),
      target_user_id INTEGER,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      author_id INTEGER REFERENCES users(id),
      title VARCHAR(200),
      body TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      author_id INTEGER REFERENCES users(id),
      title VARCHAR(200),
      body TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS game_config (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS decks (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      card_ids JSONB DEFAULT '[]'
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS conquest_progress (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      chapter_id INTEGER NOT NULL,
      stage_id INTEGER NOT NULL,
      completed_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, chapter_id, stage_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS conquest_pieces (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      chapter_id INTEGER NOT NULL,
      piece_number INTEGER NOT NULL CHECK (piece_number BETWEEN 1 AND 4),
      obtained_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, chapter_id, piece_number)
    )
  `);
  // Migrate existing progress into pieces for players who already completed stages
  await query(`
    INSERT INTO conquest_pieces (user_id, chapter_id, piece_number, obtained_at)
    SELECT user_id, chapter_id, stage_id, completed_at FROM conquest_progress
    ON CONFLICT (user_id, chapter_id, piece_number) DO NOTHING
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS warnings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Add timeout column to existing deployments
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS timeout_until TIMESTAMP`);
  // Staff chat
  await query(`
    CREATE TABLE IF NOT EXISTS staff_messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Report enhancements
  await query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS evidence_url TEXT`);
  await query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal'`);
  // Promo shop price on cards
  await query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS shop_price INTEGER DEFAULT 0`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_img TEXT`);
  await query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS print_limit INTEGER DEFAULT NULL`);
  await query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS print_count INTEGER DEFAULT 0`);
  await query(`ALTER TABLE user_cards ADD COLUMN IF NOT EXISTS print_number INTEGER DEFAULT NULL`);
  await query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT NULL`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_title TEXT DEFAULT NULL`);
  await query(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      read BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_dm_participants ON direct_messages (sender_id, recipient_id)`);
  await query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      from_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      to_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
      offered_card_ids  INTEGER[] NOT NULL DEFAULT '{}',
      requested_card_ids INTEGER[] NOT NULL DEFAULT '{}',
      status VARCHAR(20) DEFAULT 'pending',
      message TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      resolved_at TIMESTAMP DEFAULT NULL
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_trades_from ON trades (from_user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_trades_to   ON trades (to_user_id)`);
  await query(`
    CREATE TABLE IF NOT EXISTS custom_packs (
      id SERIAL PRIMARY KEY,
      pack_id VARCHAR(40) UNIQUE NOT NULL,
      name VARCHAR(80) NOT NULL,
      cost INTEGER NOT NULL DEFAULT 200,
      count INTEGER NOT NULL DEFAULT 5,
      description TEXT DEFAULT '',
      badge VARCHAR(30) DEFAULT 'CUSTOM',
      accent_color VARCHAR(20) DEFAULT '#4dd9ff',
      odds JSONB NOT NULL DEFAULT '{}',
      card_filter JSONB DEFAULT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ─── COACHES ────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS coaches (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      portrait VARCHAR(10) NOT NULL,
      buff_type VARCHAR(30) NOT NULL,
      buff_value NUMERIC NOT NULL DEFAULT 0,
      rarity VARCHAR(20) NOT NULL,
      quote_lines JSONB NOT NULL DEFAULT '[]',
      description TEXT DEFAULT ''
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_coaches (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      coach_id INTEGER REFERENCES coaches(id),
      obtained_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS equipped_coach_id INTEGER`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_done BOOLEAN DEFAULT false`);

  // ─── TRAITS ─────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS traits (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) UNIQUE NOT NULL,
      rarity VARCHAR(20) NOT NULL,
      atk_mod NUMERIC DEFAULT 0,
      def_mod NUMERIC DEFAULT 0,
      special_type VARCHAR(30) DEFAULT NULL,
      description TEXT DEFAULT ''
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_traits (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      trait_id INTEGER REFERENCES traits(id),
      obtained_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_card_traits (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER REFERENCES cards(id),
      trait_id INTEGER REFERENCES traits(id),
      equipped_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, card_id)
    )
  `);

  // ─── QUESTS & BATTLEPASS ────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS quest_definitions (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(60) UNIQUE NOT NULL,
      category VARCHAR(10) NOT NULL DEFAULT 'daily',
      name VARCHAR(100) NOT NULL,
      description TEXT,
      icon VARCHAR(10) DEFAULT '📋',
      quest_type VARCHAR(40) NOT NULL,
      target INTEGER NOT NULL,
      xp_reward INTEGER NOT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_quests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      quest_def_id INTEGER REFERENCES quest_definitions(id),
      progress INTEGER DEFAULT 0,
      completed BOOLEAN DEFAULT false,
      claimed BOOLEAN DEFAULT false,
      assigned_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_user_quests_user ON user_quests (user_id, expires_at)`);
  await query(`
    CREATE TABLE IF NOT EXISTS battlepass_rewards (
      level INTEGER PRIMARY KEY,
      xp_required INTEGER NOT NULL,
      reward_type VARCHAR(30) NOT NULL,
      reward_value INTEGER DEFAULT 0,
      reward_label VARCHAR(100),
      reward_icon VARCHAR(10) DEFAULT '🎁'
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_battlepass (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      claimed_levels INTEGER[] DEFAULT '{}',
      season INTEGER DEFAULT 1
    )
  `);

  // Seed quest definitions
  const questDefs = [
    // Daily quests
    ['daily_win1',      'daily', 'Daily Win',           'Win 1 battle',                      '⚔️', 'win_battle',      1,  100],
    ['daily_win3',      'daily', 'Battle Warrior',      'Win 3 battles',                     '🏆', 'win_battle',      3,  200],
    ['daily_pvp1',      'daily', 'Online Challenger',   'Win 1 PvP battle',                  '🎮', 'win_pvp',         1,  200],
    ['daily_cq1',       'daily', 'Conqueror',           'Complete 1 conquest stage',         '🗺️', 'win_conquest',    1,  150],
    ['daily_cq3',       'daily', 'Conquest Run',        'Complete 3 conquest stages',        '⚔️', 'win_conquest',    3,  300],
    ['daily_pack1',     'daily', 'Pack Opener',         'Open 1 pack',                       '📦', 'open_pack',       1,  100],
    ['daily_attach5',   'daily', 'Energy Master',       'Attach energy 5 times',             '⚡', 'attach_energy',   5,   75],
    ['daily_ability3',  'daily', 'Ability User',        'Use an ability 3 times',            '✦',  'use_ability',     3,  100],
    ['daily_battle5',   'daily', 'Relentless',          'Play 5 battles (win or lose)',      '🔥', 'play_battle',     5,  150],
    ['daily_pvp_play1', 'daily', 'PvP Rookie',          'Play 1 PvP battle',                 '🌐', 'play_pvp',        1,   75],
    // Weekly quests
    ['weekly_win10',    'weekly','Weekly Grind',         'Win 10 battles',                   '🏆', 'win_battle',     10,  500],
    ['weekly_pvp5',     'weekly','Ranked Warrior',       'Win 5 PvP battles',                '🎮', 'win_pvp',         5,  600],
    ['weekly_cq10',     'weekly','Conquest Champion',    'Complete 10 conquest stages',      '⚔️', 'win_conquest',   10,  700],
    ['weekly_pack3',    'weekly','Pack Addict',          'Open 3 packs',                     '📦', 'open_pack',       3,  400],
    ['weekly_play15',   'weekly','Battle Veteran',       'Play 15 battles',                  '🔥', 'play_battle',    15,  500],
    ['weekly_pvp_ranked3','weekly','Ranked Contender',  'Win 3 ranked PvP battles',          '⚔️', 'win_pvp_ranked',  3,  700],
  ];
  for (const [slug, cat, name, desc, icon, qtype, target, xp] of questDefs) {
    await query(
      `INSERT INTO quest_definitions (slug, category, name, description, icon, quest_type, target, xp_reward)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (slug) DO NOTHING`,
      [slug, cat, name, desc, icon, qtype, target, xp]
    );
  }

  // Seed battlepass rewards (30 levels, 500 XP each)
  const bpRewards = [
    [1,  500,  'coins',      100,  '+100 Coins',          '🪙'],
    [2,  1000, 'pack',         1,  'Standard Pack',        '📦'],
    [3,  1500, 'coins',      200,  '+200 Coins',          '🪙'],
    [4,  2000, 'pack',         1,  'Standard Pack',        '📦'],
    [5,  2500, 'coins',      300,  '+300 Coins',          '🪙'],
    [6,  3000, 'coach_pack',   1,  'Coach Pack',           '🎓'],
    [7,  3500, 'coins',      200,  '+200 Coins',          '🪙'],
    [8,  4000, 'pack',         2,  '2× Standard Packs',   '📦'],
    [9,  4500, 'coins',      250,  '+250 Coins',          '🪙'],
    [10, 5000, 'pack',         1,  'Rare Pack',            '✨'],
    [11, 5500, 'coins',      300,  '+300 Coins',          '🪙'],
    [12, 6000, 'pack',         2,  '2× Standard Packs',   '📦'],
    [13, 6500, 'coins',      350,  '+350 Coins',          '🪙'],
    [14, 7000, 'coach_pack',   1,  'Coach Pack',           '🎓'],
    [15, 7500, 'coins',      500,  '+500 Coins',          '🪙'],
    [16, 8000, 'pack',         2,  '2× Rare Packs',       '✨'],
    [17, 8500, 'coins',      400,  '+400 Coins',          '🪙'],
    [18, 9000, 'pack',         1,  'Epic Pack',            '💎'],
    [19, 9500, 'coins',      500,  '+500 Coins',          '🪙'],
    [20,10000, 'coach_pack',   2,  '2× Coach Packs',      '🎓'],
    [21,10500, 'coins',      500,  '+500 Coins',          '🪙'],
    [22,11000, 'pack',         3,  '3× Standard Packs',   '📦'],
    [23,11500, 'coins',      600,  '+600 Coins',          '🪙'],
    [24,12000, 'pack',         2,  '2× Epic Packs',       '💎'],
    [25,12500, 'coins',      750,  '+750 Coins',          '🪙'],
    [26,13000, 'pack',         1,  'Legendary Pack',       '👑'],
    [27,13500, 'coins',      800,  '+800 Coins',          '🪙'],
    [28,14000, 'coach_pack',   3,  '3× Coach Packs',      '🎓'],
    [29,14500, 'coins',     1000,  '+1000 Coins',         '🪙'],
    [30,15000, 'pack',         2,  '2× Legendary Packs',  '👑'],
  ];
  for (const [level, xpReq, rType, rVal, rLabel, rIcon] of bpRewards) {
    await query(
      `INSERT INTO battlepass_rewards (level, xp_required, reward_type, reward_value, reward_label, reward_icon)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (level) DO NOTHING`,
      [level, xpReq, rType, rVal, rLabel, rIcon]
    );
  }

  // ─── SEED COACHES ───────────────────────────────────────────────
  await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_coaches_name ON coaches (name)');
  const ALL_COACHES = [
    // ── Common (30) ──────────────────────────────────────────────
    ['Old Branwick',      '🧔', 'atk_bonus',  0.05, 'Common',    ["Strike with conviction!", "Don't hold back!", "You've got this!", "That's the spirit!"],          '+5% Attack'],
    ['Mira Swift',        '🏹', 'def_bonus',  0.05, 'Common',    ['Guard yourself!', 'Defense wins battles!', 'Hold the line!', 'Stay tough!'],                     '+5% Defense'],
    ['Tavros Ironbell',   '🔔', 'def_bonus',  0.03, 'Common',    ['Ring the bell!', 'Sound the guard!', 'Ready your defense!', 'Stay alert!'],                     '+3% Defense'],
    ['Lena Quickdraw',    '🎯', 'crit_bonus', 0.04, 'Common',    ['Aim true!', 'Find the gap!', 'Strike fast!', "Don't miss!"],                                     '+4% Crit chance'],
    ['Tuck the Medic',    '💊', 'heal_bonus',    1, 'Common',    ["I've got you!", 'Patch up and fight!', 'Stay in the game!', 'Never give in!'],                   '+1 Heal use'],
    ['Brix the Bold',     '💪', 'atk_bonus',  0.04, 'Common',    ['Push harder!', 'More power!', 'Give it your all!', 'Keep swinging!'],                           '+4% Attack'],
    ['Soft Nell',         '🌸', 'def_bonus',  0.04, 'Common',    ['Easy now...', 'Breathe and block!', 'Patience wins!', 'Hold steady!'],                          '+4% Defense'],
    ['Sparky Voss',       '⚡', 'crit_bonus', 0.05, 'Common',    ['Shock em!', 'Lightning reflexes!', 'Strike like thunder!', 'Zap!'],                              '+5% Crit chance'],
    ['Old Mags',          '👵', 'def_bonus',  0.03, 'Common',    ['Careful, dear.', 'Slow and steady...', 'Mind your defenses!', 'Not so fast!'],                  '+3% Defense'],
    ['Finn Tumbleweed',   '🍃', 'atk_bonus',  0.03, 'Common',    ['You can do it!', 'Keep fighting!', 'One more hit!', "Don't stop!"],                             '+3% Attack'],
    ['Captain Gregor',    '⚓', 'def_bonus',  0.06, 'Common',    ['Hold your ground!', 'Stand firm!', "Don't retreat!", 'Anchor down!'],                           '+6% Defense'],
    ['Bess the Brave',    '🦁', 'atk_bonus',  0.06, 'Common',    ['Roar and strike!', 'Be brave!', 'Attack with heart!', 'Raw courage!'],                          '+6% Attack'],
    ['Ember Flint',       '🔥', 'atk_bonus',  0.04, 'Common',    ['Light them up!', 'Burn bright!', 'Heat things up!', 'Ignite!'],                                 '+4% Attack'],
    ['Frost Nara',        '❄️', 'def_bonus',  0.04, 'Common',    ['Cool and collected.', 'Ice them out.', 'Stay cold!', 'Chill defense!'],                         '+4% Defense'],
    ['Jax the Scrapper',  '🥊', 'crit_bonus', 0.03, 'Common',    ['Go for broke!', 'Land a big one!', "Don't miss!", 'Scrappy!'],                                  '+3% Crit chance'],
    ['Scout Ren',         '🔭', 'crit_bonus', 0.06, 'Common',    ['I see an opening!', 'There! Strike there!', 'Perfect angle!', 'Spotted!'],                      '+6% Crit chance'],
    ['Bulk the Wall',     '🧱', 'def_bonus',  0.07, 'Common',    ["You're a fortress!", 'Nothing gets through!', 'Stone cold defense!', 'Unmovable!'],              '+7% Defense'],
    ['Whisper',           '🌙', 'atk_bonus',  0.05, 'Common',    ['Quietly now...', 'Surprise them!', 'Strike from shadows!', 'Silent strike!'],                   '+5% Attack'],
    ['Gravel Joe',        '🪨', 'def_bonus',  0.05, 'Common',    ['Stand like a rock!', 'Unmovable!', 'Rock solid!', 'Earth and stone!'],                           '+5% Defense'],
    ['Pip Sparklefist',   '✨', 'crit_bonus', 0.04, 'Common',    ['Make it count!', 'Sparkle and shine!', 'Dazzle them!', 'Glittering strike!'],                    '+4% Crit chance'],
    ['Hana the Herbalist','🌱', 'heal_bonus',    1, 'Common',    ['Rest and recover!', 'Nature heals all!', 'Keep going!', 'Roots run deep!'],                      '+1 Heal use'],
    ['Skar the Hungry',   '🐺', 'atk_bonus',  0.06, 'Common',    ['Bite hard!', 'Hungry for victory!', "Don't stop attacking!", 'Savage!'],                        '+6% Attack'],
    ['Zara Windwhisper',  '💨', 'crit_bonus', 0.05, 'Common',    ['Like the wind!', 'Swift and true!', 'Catch them off guard!', 'Breeze through!'],                 '+5% Crit chance'],
    ['Bolo the Cheerful', '😄', 'orb_start',     1, 'Common',    ['Smile and fight!', 'Happy to help!', "You've got energy!", 'Keep it up!'],                      'Start with +1 Orb'],
    ['Narek of the East', '🧭', 'atk_bonus',  0.04, 'Common',    ['Stay the course!', 'Eyes on the prize!', 'Victory is ahead!', 'Navigate to win!'],              '+4% Attack'],
    ['Dora Steadfast',    '🤝', 'def_bonus',  0.04, 'Common',    ["I'm with you!", 'Together we stand!', 'Hold strong!', 'Side by side!'],                         '+4% Defense'],
    ['Young Kira',        '🌟', 'crit_bonus', 0.05, 'Common',    ["Show them what you've got!", 'This is your moment!', 'Believe in yourself!', 'Shine!'],          '+5% Crit chance'],
    ['Torg the Tired',    '😴', 'heal_bonus',    1, 'Common',    ['Take a breather...', 'Rest up...', 'You need this...', 'Almost there...'],                       '+1 Heal use'],
    ['Deke Ironside',     '🔩', 'def_bonus',  0.06, 'Common',    ['Shield up!', 'Block everything!', 'Nothing gets past you!', 'Iron wall!'],                       '+6% Defense'],
    ['Grum Steadhand',    '🪛', 'atk_bonus',  0.05, 'Common',    ['Tighten your grip!', 'Steady aim!', "Don't waver!", 'Mechanical precision!'],                    '+5% Attack'],
    // ── Rare (12) ────────────────────────────────────────────────
    ['Warden Tesh',       '🔮', 'orb_start',     1, 'Rare',      ['Channel your energy!', 'The orbs are yours!', 'Harness the power!', 'Energy flows through you!'], 'Start with +1 Orb on all cards'],
    ['Captain Lyn',       '⚔️', 'crit_bonus', 0.08, 'Rare',      ['Find the gap!', 'Strike their weakness!', 'Hit where it hurts!', 'Precision is everything!'],    '+8% Crit chance'],
    ['Marek the Duelist', '🗡️', 'atk_bonus',  0.10, 'Rare',      ['Press the attack!', 'Never let up!', "Duelist's honor!", 'Strike and withdraw!'],                '+10% Attack'],
    ['Hela Stoneborn',    '🗿', 'def_bonus',  0.10, 'Rare',      ["Mountain's endurance!", 'Nothing breaks you!', 'Unyielding!', 'Stone and iron!'],                '+10% Defense'],
    ['Crux the Gambler',  '🎲', 'crit_bonus', 0.10, 'Rare',      ['Roll the dice!', 'High risk, high reward!', 'Lucky shot!', 'All in!'],                           '+10% Crit chance'],
    ['Soren the Sage',    '📚', 'orb_start',     2, 'Rare',      ['Knowledge is power!', 'Study your opponent!', 'The wise strike once!', 'Prepare!'],              'Start with +2 Orbs on all cards'],
    ['Brother Vael',      '☯️', 'heal_bonus',    1, 'Rare',      ['Balance in all things.', 'Restore harmony!', 'The wounded can still win!', 'Recover swiftly!'],  '+1 Heal use'],
    ['Vex the Quick',     '🏃', 'crit_bonus', 0.09, 'Rare',      ['Speed is strength!', 'In and out!', "Don't let them react!", 'Quick as lightning!'],             '+9% Crit chance'],
    ['Mirna Coldwater',   '🌊', 'def_bonus',  0.09, 'Rare',      ['Let the tide protect you!', 'Flow like water!', 'Adapt and endure!', 'Steady currents!'],        '+9% Defense'],
    ['Torrin the Veteran','🎖️', 'atk_bonus',  0.09, 'Rare',      ["Experience is the best weapon!", "I've seen this before!", "Veteran's instinct!", 'Years of training!'], '+9% Attack'],
    ['Lux Brightforge',   '💡', 'atk_bonus',  0.08, 'Rare',      ['Illuminate the path!', 'Strike where it matters!', 'Light the way!', 'Forge ahead!'],           '+8% Attack'],
    ['Nyla Shadowstep',   '👤', 'crit_bonus', 0.07, 'Rare',      ['From the shadows!', 'They never saw it coming!', 'Shadow and silence!', 'Strike unseen!'],       '+7% Crit chance'],
    // ── Epic (6) ─────────────────────────────────────────────────
    ['Archmage Corvin',   '🧙', 'atk_bonus',  0.15, 'Epic',      ['Unleash the arcane!', 'Power beyond measure!', 'Let the magic flow!', 'Destroy them!'],          '+15% Attack'],
    ['Iron Matron Segg',  '🛡️', 'def_bonus',  0.15, 'Epic',      ['Iron defense!', 'Nothing gets through!', 'Be the wall!', 'Let them tire!'],                     '+15% Defense'],
    ['Gale Stormbringer', '🌪️', 'crit_bonus', 0.15, 'Epic',      ['The storm answers!', 'Whirlwind assault!', 'Strike like lightning!', 'Unleash the tempest!'],    '+15% Crit chance'],
    ['Oracle Veth',       '👁️', 'orb_start',     3, 'Epic',      ['I foresaw this moment!', 'The future is clear!', 'Destiny grants you power!', 'Charge!'],       'Start with +3 Orbs on all cards'],
    ['Draken the Enduring','🐲', 'def_bonus', 0.20, 'Epic',      ['Dragon scales endure!', 'Nothing breaks a dragon!', 'Ancient endurance!', 'Tank every blow!'],   '+20% Defense'],
    ['Thornback Rais',    '🌵', 'heal_bonus',    2, 'Epic',      ['Desert survival!', 'Outlast everything!', 'The tough survive!', 'Twice the recovery!'],           '+2 Heal uses'],
    // ── Legendary (2) ────────────────────────────────────────────
    ['The Champion',      '👑', 'coins_bonus',   3, 'Legendary', ['Victory brings riches!', 'Champions are rewarded!', 'Win for glory!', 'The prize awaits!'],       '3× Coins from battles'],
    ['Void Watcher Eryx', '🌑', 'heal_bonus',    1, 'Legendary', ['Endure!', 'Never fall!', 'Rise again!', 'You can survive this!'],                                '+1 Heal use in battle'],
  ];
  for (const [name, portrait, buff_type, buff_value, rarity, quotes, description] of ALL_COACHES) {
    await query(
      'INSERT INTO coaches (name, portrait, buff_type, buff_value, rarity, quote_lines, description) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (name) DO NOTHING',
      [name, portrait, buff_type, buff_value, rarity, JSON.stringify(quotes), description]
    );
  }
  const finalCount = await query('SELECT COUNT(*) FROM coaches');
  if (parseInt(finalCount.rows[0].count) >= 50) console.log('50 coaches ready.');

  // ─── SEED TRAITS ────────────────────────────────────────────────
  const traitCount = await query('SELECT COUNT(*) FROM traits');
  if (parseInt(traitCount.rows[0].count) === 0) {
    const traits = [
      ['Brave',     'Legendary',  0.05,  -0.0525, null,   '+5% Attack, -5.25% Defense — Bold in the face of danger.'],
      ['Fearful',   'Common',    -0.10,   0.20,   null,   '-10% Attack, +20% Defense — Survival instinct takes over.'],
      ['Toughness', 'Rare',      -0.11,   0.10,   null,   '-11% Attack, +10% Defense — Built to endure punishment.'],
      ['Void',      'Secret',     0,       0,     'void', 'Stores damage for 4 turns, releases all at once +50 bonus. Drains bench energy.'],
    ];
    for (const [name, rarity, atk_mod, def_mod, special_type, description] of traits) {
      await query(
        'INSERT INTO traits (name, rarity, atk_mod, def_mod, special_type, description) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (name) DO NOTHING',
        [name, rarity, atk_mod, def_mod, special_type, description]
      );
    }
    console.log('Traits seeded.');
  }
}

const TYPES = ['Fire','Water','Earth','Air','Shadow','Light','Thunder','Ice','Poison','Psychic','Nature','Metal','Dragon','Cosmic','Void','Crystal','Blood','Spirit','Chaos','Dream'];
const CLASSES = ['Beast','Dragon','Golem','Sprite','Demon','Angel','Undead','Elemental','Construct','Titan'];
const STARTS = ['Vol','Kry','Thex','Mor','Aeg','Bael','Cyr','Drak','Eln','Fyr','Geth','Hav','Ith','Jor','Kael','Lyr','Myx','Nyl','Oryn','Pyx','Qua','Riv','Syl','Tyr','Ux','Vex','Wyr','Xen','Ysh','Zor','Arc','Brim','Cor','Den','Eth','Fin','Gal','Hel','Irk','Jev','Kel','Lom','Mak','Nox','Onk','Par','Ren','Sol','Tan','Uri','Vel','Wen','Xar','Ynd','Zel','Ash','Bel','Ceth','Dor','Elv'];
const ENDS = ['thrax','vore','ryn','keth','mus','lux','dra','gon','rix','tus','nyx','mor','zel','phos','cyn','thul','vax','rak','syl','don','lor','fen','crus','thar','nox','vel','kris','phen','zar','loth','wyn','fur','mar','kin','set','bane','forge','claw','fang','wing','maw','rend','surge','bloom','tide','flare','crush','void','pulse','echo','rift','shade','glow','storm','frost','blaze','quake','dart','spike','coil','wraith','herald','keeper','warden','hunter','seeker','weaver','singer','dancer','walker','runner','leaper','diver','striker','guard','sentinel','champion','titan','colossus','behemoth','wyrm','hydra','golem','revenant','specter','phantom','banshee','demon','seraph','djinn','naga','sphinx','basilisk','chimera','manticore','kraken','leviathan','roc','wyvern','cockatrice','griffon','kirin','tengu','oni','raiju','baku','kitsune','tanuki','inari','orochi','raijin','fujin','susanoo','ebisu','bishamon','daikoku','hotei','jurojin','toshi','hebi','tatsu','hitsuji','ne','usagi','inu','tori','moku','sui','do','tsuchi','kaze','yama','kawa','umi','sora','hoshi','tsuki','yoru','asa','kage','hikari','abyss','ember','glacius','thornback','obsidian','prisma','venom','mirage','thunder','zephyr','terra','lumis','umbra','corona','nexus','fractal','hollow','tempest','cascade','verdant'];
const ABILITIES = [
  ['Ember Strike',40,'A quick burst of flame that scorches the target'],
  ['Inferno Blast',90,'Unleashes a roaring wall of fire'],
  ['Volcanic Surge',120,'Erupts with the fury of a volcano'],
  ['Scorching Fang',70,'Bites down with searing heat'],
  ['Ash Cloud',45,'Blinds the target with choking ash'],
  ['Magma Slam',100,'Crashes into the foe like falling lava'],
  ['Flame Coil',60,'Wraps the foe in burning coils'],
  ['Cinder Burst',80,'Pelts the target with burning cinders'],
  ['Tidal Crash',90,'A crushing wave of oceanic force'],
  ['Deep Surge',110,'Draws power from the darkest ocean depths'],
  ['Whirlpool Fang',65,'Bites while spinning in a vortex of water'],
  ['Frost Tide',75,'A wave that freezes on contact'],
  ['Rain Hammer',85,'Drives down like a thunderstorm'],
  ['Bubble Barrage',50,'Fires rapid-fire bubbles at high pressure'],
  ['Rock Slam',80,'Brings down a massive chunk of earth'],
  ['Seismic Drive',110,'Channels quake energy into a single strike'],
  ['Thorn Crush',55,'Pierces through tough defenses'],
  ['Mudslide',70,'Engulfs the foe in a torrent of earth'],
  ['Gust Slash',45,'Cuts with razor-sharp air'],
  ['Cyclone Fist',95,'Spins and delivers a whirling blow'],
  ['Tempest Wing',75,'Beats wings with hurricane force'],
  ['Vacuum Cut',65,'Slices with a blade of compressed air'],
  ['Shadow Claw',70,'Rakes with claws made of pure darkness'],
  ['Void Drain',80,'Siphons life force into the void'],
  ['Dark Matter',105,'Unleashes condensed darkness'],
  ['Soul Rend',90,'Tears at the target\'s spirit'],
  ['Radiant Burst',85,'Explodes with blinding holy light'],
  ['Solar Beam',115,'Channels concentrated sunlight'],
  ['Flash Strike',60,'A blinding attack at the speed of light'],
  ['Holy Smite',95,'Delivers a righteous blow of light energy'],
  ['Thunder Crack',90,'Releases a deafening thunderclap'],
  ['Lightning Fang',80,'Bites with the speed of lightning'],
  ['Static Pulse',55,'Sends jolts through the air'],
  ['Arc Discharge',110,'Fires a concentrated arc of electricity'],
  ['Blizzard Slash',85,'Cuts with frozen wind'],
  ['Glacial Slam',100,'Brings down a block of ancient ice'],
  ['Frost Bite',70,'Bites deep with freezing cold'],
  ['Ice Shard Volley',75,'Fires a barrage of razor ice shards'],
  ['Poison Fang',65,'Injects venom with a precise bite'],
  ['Venom Spray',80,'Coats the target in toxic liquid'],
  ['Toxic Surge',95,'Releases a wave of concentrated poison'],
  ['Corrosive Spit',70,'Spits acid that eats through armor'],
  ['Mind Crush',85,'Psychic pressure crushes the target\'s thoughts'],
  ['Psi Blast',100,'Fires a bolt of pure psychic energy'],
  ['Telekinetic Slam',110,'Hurls the target with telekinesis'],
  ['Neural Shock',75,'Overloads the target\'s nervous system'],
  ['Vine Whip',50,'Lashes out with thorned vines'],
  ['Nature\'s Wrath',95,'Channels the fury of the wild'],
  ['Spore Cloud',60,'Releases a cloud of toxic spores'],
  ['Root Crush',80,'Constricts with grasping roots'],
  ['Iron Slam',90,'Delivers a crushing blow of solid metal'],
  ['Steel Fang',75,'Bites with teeth like tempered steel'],
  ['Magnetic Pulse',85,'Emits a disruptive magnetic burst'],
  ['Metal Storm',115,'Hurls shards of razor-sharp metal'],
  ['Dragon Claw',95,'Rakes with legendary dragon claws'],
  ['Draconic Fire',120,'Breathes the fire of an ancient dragon'],
  ['Dragon Pulse',100,'Releases a wave of dragon energy'],
  ['Wyrmfang',110,'Bites with the force of a great wyrm'],
  ['Star Crash',120,'Calls down the force of a dying star'],
  ['Cosmic Ray',95,'Fires beams of cosmic radiation'],
  ['Nebula Wave',85,'Sends ripples through the fabric of space'],
  ['Gravity Crush',110,'Intensifies local gravity to crush the target'],
  ['Void Collapse',130,'Implodes space around the target'],
  ['Null Beam',100,'Fires a beam that negates energy'],
  ['Entropy Wave',115,'Accelerates decay in everything it touches'],
  ['Abyss Pull',90,'Drags the target toward the void'],
  ['Crystal Lance',85,'Fires a spear of razor crystal'],
  ['Prism Burst',95,'Refracts energy into a blinding blast'],
  ['Crystalline Edge',75,'Cuts with a blade grown from pure crystal'],
  ['Shard Storm',110,'Creates a blizzard of crystal fragments'],
  ['Blood Surge',90,'Channels vital force into a devastating strike'],
  ['Crimson Fang',80,'Bites and drains the target\'s strength'],
  ['Hemorrhage',100,'Causes internal damage that lingers'],
  ['Life Drain',85,'Absorbs the target\'s life energy'],
  ['Spirit Wave',70,'Sends a wave of spiritual energy'],
  ['Soul Strike',90,'Hits the spirit directly, bypassing armor'],
  ['Ethereal Slash',80,'Cuts with a blade of pure spirit'],
  ['Phantom Rush',85,'Rushes through the target like a ghost'],
  ['Chaos Burst',120,'Releases unstable chaotic energy'],
  ['Entropy Strike',110,'Strikes with the force of disorder'],
  ['Mayhem Wave',100,'Sends out a wave of chaotic destruction'],
  ['Discord Pulse',90,'Disrupts all order in the target\'s body'],
  ['Dream Veil',65,'Wraps the target in a numbing dream'],
  ['Nightmare Surge',100,'Draws power from endless nightmares'],
  ['Somnolent Strike',80,'Puts the target to sleep with the blow'],
  ['Phantasm Wave',90,'A wave that confuses and disorients'],
  ['Feral Bite',60,'A savage, unrestrained bite'],
  ['Reckless Charge',85,'Throws all caution aside to charge'],
  ['Berserker Slash',95,'Attacks in a wild, uncontrolled fury'],
  ['Battle Roar',75,'A roar that channels pure fighting spirit'],
  ['Titan Crush',130,'The legendary crushing force of a titan'],
  ['Colossus Strike',125,'A strike with the power of a colossus'],
  ['Behemoth Slam',120,'The raw force of a primordial behemoth'],
  ['Undead Grasp',70,'Grabs with the cold grip of the undead'],
  ['Revenant Strike',85,'Strikes with the vengeance of the fallen'],
  ['Spectral Claw',75,'Rakes with ghostly claws'],
  ['Wraith Touch',80,'A touch that chills to the bone'],
  ['Golem Fist',100,'A punch with the force of stone'],
  ['Construct Beam',90,'Fires a concentrated energy beam'],
  ['Mechanical Slam',95,'A powerful mechanical strike'],
  ['Sprite Dart',40,'A quick dart of fey energy'],
  ['Fey Blast',70,'A burst of unpredictable fey magic'],
  ['Fairy Ring',60,'Traps the target in a circle of fey power'],
  ['Seraphic Smite',115,'A divine strike from an angelic being'],
  ['Heavenly Beam',110,'Calls down a beam from the heavens'],
  ['Djinn Surge',100,'Releases the bottled power of a djinn'],
  ['Demon Claw',95,'Tears with claws born of hellfire'],
  ['Basilisk Gaze',85,'A gaze that petrifies with fear'],
  ['Chimera Breath',105,'Breathes a mixture of fire, poison, and ice'],
  ['Manticore Sting',90,'Stings with a venom-tipped tail'],
  ['Kraken Grab',115,'Wraps in crushing tentacles'],
  ['Phoenix Flame',110,'Burns with the sacred fire of rebirth'],
  ['Leviathan Wave',125,'Calls down the wrath of the sea serpent'],
  ['Hydra Fang',100,'Bites with one of many heads simultaneously'],
  ['Wyrm Breath',120,'Breathes the ancient power of a great wyrm'],
  ['Sphinx Riddle',75,'Confounds the target with impossible power'],
  ['Griffon Dive',95,'Swoops down at incredible speed'],
  ['Kirin Bolt',100,'Channels the power of the sacred kirin']
];
const WEAKNESS_MAP = {Fire:'Water',Water:'Thunder',Earth:'Nature',Air:'Ice',Shadow:'Light',Light:'Shadow',Thunder:'Earth',Ice:'Fire',Poison:'Psychic',Psychic:'Void',Nature:'Poison',Metal:'Fire',Dragon:'Ice',Cosmic:'Void',Void:'Light',Crystal:'Metal',Blood:'Nature',Spirit:'Chaos',Chaos:'Psychic',Dream:'Shadow'};
const RESISTANCE_MAP = {Fire:'Nature',Water:'Fire',Earth:'Metal',Air:'Earth',Shadow:'Psychic',Light:'Chaos',Thunder:'Air',Ice:'Water',Poison:'Nature',Psychic:'Dream',Nature:'Water',Metal:'Ice',Dragon:'Fire',Cosmic:'Psychic',Void:'Shadow',Crystal:'Water',Blood:'Metal',Spirit:'Shadow',Chaos:'Dream',Dream:'Light'};
const FLAVORS = [
  'Said to have been born in the heart of a dying star.',
  'Ancient texts describe its roar as the sound of creation.',
  'No one who has seen its true form has ever returned.',
  'It wanders the furthest reaches of the known world alone.',
  'Scholars argue whether it is creature or force of nature.',
  'Its footsteps leave marks that last for centuries.',
  'Believed to have existed before the first continent formed.',
  'Its eyes reflect every world it has witnessed.',
  'Those who seek it never find it - it finds them.',
  'Even the mightiest creatures give way when it approaches.',
  'It has slept for a thousand years and is only now stirring.',
  'Its voice can reshape the landscape around it.',
  'Found only where two elemental forces collide.',
  'Its shadow is darker than the deepest cave.',
  'It has no memory of its own origin, and neither does anyone else.',
  'Travelers report hearing its call from impossible distances.',
  'It does not hunt. It simply exists, and things come to it.',
  'Its passage changes the weather for weeks afterward.',
  'It has been known to appear during pivotal moments in history.',
  'What it desires, no one can say. What it is capable of, all know.'
];
const ART_STYLES = ['sketch','ink','watercolor','charcoal','pencil','crosshatch'];
const SET_NAMES = ['Primordial Dawn','Shattered Realms','Void Ascension','Mythic Origins','Celestial Storm','Ancient Reckoning','Chaos Eternal','Twilight Dominion','Abyssal Surge','Crystal Epoch','Spectral Rift','Iron Legacy','Dream Woven','Blood Covenant','Spirit Unleashed','Titan\'s Wrath','Elemental War','Shadow Protocol','Light Absolute','Dragon Heritage'];

function getRarity(i) {
  const v = (i * 7 + 13) % 1000;
  if (v < 400) return 'Common';
  if (v < 650) return 'Uncommon';
  if (v < 800) return 'Rare';
  if (v < 880) return 'Ultra_Rare';
  if (v < 920) return 'Secret_Rare';
  if (v < 950) return 'Full_Art';
  if (v < 970) return 'Parallel';
  if (v < 990) return 'Numbered';
  if (v < 997) return 'Prism';
  return 'Mythic';
}

function getStats(rarity, i) {
  const tier = ['Common','Uncommon','Rare','Ultra_Rare','Secret_Rare','Full_Art','Parallel','Numbered','Prism','Mythic'].indexOf(rarity);
  const base = 40 + tier * 25;
  const spread = 30 + tier * 10;
  const hp = base + ((i * 11) % spread) + (tier * 20);
  const atk = 20 + tier * 8 + ((i * 13) % 25);
  const def = 10 + tier * 6 + ((i * 17) % 20);
  const spd = 10 + tier * 5 + ((i * 19) % 25);
  return { hp: Math.min(hp, 300), atk: Math.min(atk, 130), def: Math.min(def, 100), spd: Math.min(spd, 100) };
}

function generateCard(i) {
  const startIdx = Math.floor(i / ENDS.length);
  const endIdx = i % ENDS.length;
  const name = STARTS[startIdx] + ENDS[endIdx];
  const type = TYPES[i % TYPES.length];
  const cls = CLASSES[i % CLASSES.length];
  const rarity = getRarity(i);
  const stats = getStats(rarity, i);
  const ability = ABILITIES[i % ABILITIES.length];
  const isParallel = rarity === 'Parallel';
  const isNumbered = rarity === 'Numbered';
  const printRun = isNumbered ? 100 : null;
  const cardNumSeq = isNumbered ? String((i % 100) + 1).padStart(3,'0') + '/100' : String(i+1).padStart(3,'0') + '/200';
  const setIdx = Math.floor(i / (Math.ceil(200 / SET_NAMES.length)));
  const setName = SET_NAMES[setIdx % SET_NAMES.length];
  const flavor = FLAVORS[i % FLAVORS.length];
  const artStyle = ART_STYLES[i % ART_STYLES.length];
  const retreat = 1 + (i % 4);
  return [
    i + 1, name, type, cls, stats.hp, stats.atk, stats.def, stats.spd,
    ability[0], ability[2], ability[1], retreat,
    WEAKNESS_MAP[type], RESISTANCE_MAP[type],
    rarity, isParallel, isNumbered, cardNumSeq, printRun, setName, flavor, artStyle
  ];
}

async function seedCards() {
  const existing = await query('SELECT COUNT(*) FROM cards WHERE id <= 200');
  const count = parseInt(existing.rows[0].count);
  if (count >= 200) return;
  console.log('Seeding missing base cards...');
  const BATCH = 50;
  for (let batch = 0; batch < Math.ceil(200 / BATCH); batch++) {
    const values = [];
    const params = [];
    let paramIdx = 1;
    for (let j = 0; j < BATCH; j++) {
      const i = batch * BATCH + j;
      if (i >= 200) break;
      const card = generateCard(i);
      values.push(`($${paramIdx},$${paramIdx+1},$${paramIdx+2},$${paramIdx+3},$${paramIdx+4},$${paramIdx+5},$${paramIdx+6},$${paramIdx+7},$${paramIdx+8},$${paramIdx+9},$${paramIdx+10},$${paramIdx+11},$${paramIdx+12},$${paramIdx+13},$${paramIdx+14},$${paramIdx+15},$${paramIdx+16},$${paramIdx+17},$${paramIdx+18},$${paramIdx+19},$${paramIdx+20},$${paramIdx+21})`);
      params.push(...card);
      paramIdx += 22;
    }
    if (values.length === 0) break;
    await query(`INSERT INTO cards (id,name,type,class,hp,atk,def,spd,ability_name,ability_desc,ability_power,retreat_cost,weakness,resistance,rarity,is_parallel,is_numbered,card_number,print_run,set_name,flavor_text,art_style) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
    console.log(`  Inserted batch ${batch+1}/${Math.ceil(200/BATCH)}`);
  }
  console.log('Cards seeded.');
}

async function seedAdmin() {
  const bcrypt = require('bcryptjs');
  // Remove old dev account if it exists (delete dependents first)
  const oldDev = await query("SELECT id FROM users WHERE username = 'AMGProdZ'");
  if (oldDev.rows.length > 0) {
    const oldId = oldDev.rows[0].id;
    // Nullify non-cascade FK references before deleting
    await query("UPDATE matches       SET player1_id = NULL  WHERE player1_id = $1", [oldId]);
    await query("UPDATE reports       SET reporter_id = NULL WHERE reporter_id = $1", [oldId]);
    await query("UPDATE reports       SET reported_user_id = NULL WHERE reported_user_id = $1", [oldId]);
    await query("UPDATE reports       SET handled_by = NULL  WHERE handled_by = $1", [oldId]);
    await query("UPDATE admin_logs    SET admin_id = NULL    WHERE admin_id = $1", [oldId]);
    await query("UPDATE announcements SET author_id = NULL   WHERE author_id = $1", [oldId]);
    await query("UPDATE news          SET author_id = NULL   WHERE author_id = $1", [oldId]);
    await query("DELETE FROM users WHERE id = $1", [oldId]);
  }
  // Create new dev account only if it doesn't exist
  const existing = await query("SELECT id FROM users WHERE username = 'AMGProdZ27'");
  if (existing.rows.length > 0) return;
  const hash = await bcrypt.hash('20261248', 12);
  const res = await query(
    "INSERT INTO users (username, password_hash, role, coins) VALUES ($1, $2, $3, $4) RETURNING id",
    ['AMGProdZ27', hash, 'developer', 1000]
  );
  const uid = res.rows[0].id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]);
  await query('INSERT INTO ranked_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]);
  console.log('Developer account AMGProdZ27 created.');
}

module.exports = { pool, query, initDB, seedCards, seedAdmin, TYPES, CLASSES, ABILITIES, STARTS, ENDS };
