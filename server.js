require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { query, initDB, seedCards, seedAdmin } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'mythical_tcg_dev_secret';

// ─── SERVER-SIDE BATTLE STORE ────────────────────────────────────
const activeBattles = new Map(); // userId -> battleState

// ─── PVP STORE ───────────────────────────────────────────────────
const pvpQueue    = new Map(); // userId -> { userId, username, ranked, cards, joinedAt }
const pvpBattles  = new Map(); // battleId -> battleState
const userToBattle = new Map();   // userId -> battleId

const TYPES = ['Fire','Water','Earth','Air','Shadow','Light','Thunder','Ice','Poison','Psychic','Nature','Metal','Dragon','Cosmic','Void','Crystal','Blood','Spirit','Chaos','Dream'];
const WEAKNESS_MAP = {Fire:'Water',Water:'Thunder',Earth:'Nature',Air:'Ice',Shadow:'Light',Light:'Shadow',Thunder:'Earth',Ice:'Fire',Poison:'Psychic',Psychic:'Void',Nature:'Poison',Metal:'Fire',Dragon:'Ice',Cosmic:'Void',Void:'Light',Crystal:'Metal',Blood:'Nature',Spirit:'Chaos',Chaos:'Psychic',Dream:'Shadow'};
const RESISTANCE_MAP = {Fire:'Nature',Water:'Fire',Earth:'Metal',Air:'Earth',Shadow:'Psychic',Light:'Chaos',Thunder:'Air',Ice:'Water',Poison:'Nature',Psychic:'Dream',Nature:'Water',Metal:'Ice',Dragon:'Fire',Cosmic:'Psychic',Void:'Shadow',Crystal:'Water',Blood:'Metal',Spirit:'Shadow',Chaos:'Dream',Dream:'Light'};

function calcDamage(attacker, defender) {
  let mult = 1;
  if (attacker.type === defender.weakness)    mult = 2;
  if (attacker.type === defender.resistance)  mult = 0.5;
  const raw = Math.floor(attacker.atk * (attacker.ability_power / 100) * mult - defender.def * 0.3);
  return Math.max(10, raw);
}

function calcBasicDamage(attacker, defender, extraCrit = 0) {
  let mult = 1;
  if (attacker.type === defender.weakness)   mult = 2;
  if (attacker.type === defender.resistance) mult = 0.5;
  const crit = Math.random() < (0.12 + extraCrit);
  const base = Math.floor(attacker.atk * 0.4 * mult - defender.def * 0.2);
  return { dmg: Math.max(5, crit ? Math.floor(base * 1.5) : base), crit };
}

function orbCost(card) { return (card.retreat_cost || 2) + 1; }

function typeEffectText(attacker, defender) {
  if (attacker.type === defender.weakness)   return ' Super effective!';
  if (attacker.type === defender.resistance) return ' Not very effective.';
  return '';
}

function processStatusDamage(card, battle, isPlayer) {
  if (!card.status || card.status.type === 'freeze' || card.status.type === 'paralysis') return;
  const pct = card.status.type === 'burn' ? 0.08 : 0.06;
  const dmg = Math.max(1, Math.floor(card.hp * pct));
  card.current_hp = Math.max(0, card.current_hp - dmg);
  const icon = card.status.type === 'burn' ? '🔥' : '☠️';
  const who = isPlayer ? `Your ${card.name}` : `Foe's ${card.name}`;
  battle.log.push(`${icon} ${who} takes ${dmg} ${card.status.type} damage!`);
  card.status.turnsLeft--;
  if (card.status.turnsLeft <= 0) { const t = card.status.type; card.status = null; battle.log.push(`${who}'s ${t} wore off.`); }
}

function checkPlayerStatusBlock(battle) {
  const pa = battle.playerCards[battle.playerActive];
  if (!pa.status) return false;
  if (pa.status.type === 'freeze') {
    battle.log.push(`❄️ Your ${pa.name} is frozen and cannot act!`);
    pa.status.turnsLeft--;
    if (pa.status.turnsLeft <= 0) { pa.status = null; battle.log.push(`Your ${pa.name} thawed out!`); }
    return true;
  }
  if (pa.status.type === 'paralysis') {
    pa.status.turnsLeft--;
    if (pa.status.turnsLeft <= 0) pa.status = null;
    if (Math.random() < 0.4) { battle.log.push(`⚡ Your ${pa.name} is paralyzed and can't move!`); return true; }
  }
  return false;
}

function applyStatus(attacker, defender, battle) {
  if (defender.status) return;
  const map = {
    'Fire':    { type: 'burn',      turnsLeft: 2, chance: 0.30, icon: '🔥' },
    'Poison':  { type: 'poison',    turnsLeft: 3, chance: 0.40, icon: '☠️' },
    'Ice':     { type: 'freeze',    turnsLeft: 1, chance: 0.25, icon: '❄️' },
    'Psychic': { type: 'paralysis', turnsLeft: 2, chance: 0.28, icon: '⚡' },
    'Thunder': { type: 'paralysis', turnsLeft: 2, chance: 0.32, icon: '⚡' },
  };
  const entry = map[attacker.type];
  if (!entry || Math.random() >= entry.chance) return;
  defender.status = { type: entry.type, turnsLeft: entry.turnsLeft };
  battle.log.push(`${entry.icon} ${defender.name} is inflicted with ${entry.type}!`);
}

function getBenchBonus(cards, activeIdx) {
  const t = cards[activeIdx].type;
  return cards.filter((c, i) => i !== activeIdx && c.current_hp > 0 && c.type === t).length >= 2 ? 1.1 : 1;
}

function advanceFainted(battle) {
  if (battle.playerCards[battle.playerActive]?.current_hp <= 0) {
    const next = battle.playerCards.findIndex((c,i) => i !== battle.playerActive && c.current_hp > 0);
    if (next !== -1) { battle.playerActive = next; battle.log.push(`Your ${battle.playerCards[next].name} steps forward!`); }
  }
  if (battle.aiCards[battle.aiActive]?.current_hp <= 0) {
    const next = battle.aiCards.findIndex((c,i) => i !== battle.aiActive && c.current_hp > 0);
    if (next !== -1) { battle.aiActive = next; battle.log.push(`Foe sends out ${battle.aiCards[next].name}!`); }
  }
}

function checkWin(battle) {
  const pAlive = battle.playerCards.some(c => c.current_hp > 0);
  const aAlive = battle.aiCards.some(c => c.current_hp > 0);
  if (!pAlive || !aAlive) {
    battle.finished = true;
    battle.winner = pAlive ? 'player' : 'ai';
    battle.log.push(pAlive ? 'You win! All enemy creatures defeated!' : 'You lost... All your creatures were defeated.');
    return true;
  }
  return false;
}

function runAiTurn(battle) {
  const pa = battle.playerCards[battle.playerActive];
  // AI switches if weak to player type
  if (battle.aiCards[battle.aiActive].weakness === pa.type) {
    const better = battle.aiCards.findIndex((c,i) => i !== battle.aiActive && c.current_hp > 0 && c.weakness !== pa.type);
    if (better !== -1) {
      battle.aiActive = better;
      battle.log.push(`Foe switched to ${battle.aiCards[battle.aiActive].name}!`);
    }
  }
  const aiActive = battle.aiCards[battle.aiActive];
  // AI auto-attaches 1 energy to its active card each turn
  aiActive.orbs = (aiActive.orbs || 0) + 1;
  // Process AI status damage (burn/poison)
  processStatusDamage(aiActive, battle, false);
  if (aiActive.current_hp <= 0) { battle.playerEnergyAttached = false; return; }
  // Check AI freeze/paralysis
  if (aiActive.status?.type === 'freeze') {
    battle.log.push(`❄️ Foe's ${aiActive.name} is frozen and cannot act!`);
    aiActive.status.turnsLeft--;
    if (aiActive.status.turnsLeft <= 0) { aiActive.status = null; battle.log.push(`Foe's ${aiActive.name} thawed out!`); }
    battle.playerEnergyAttached = false;
    return;
  }
  if (aiActive.status?.type === 'paralysis') {
    aiActive.status.turnsLeft--;
    if (aiActive.status.turnsLeft <= 0) aiActive.status = null;
    if (Math.random() < 0.4) { battle.log.push(`⚡ Foe's ${aiActive.name} is paralyzed and can't move!`); battle.playerEnergyAttached = false; return; }
  }
  // Boss enrage at ≤50% HP (one-time)
  if (aiActive.isBossCard && !battle.bossEnraged && aiActive.current_hp <= aiActive.hp * 0.5) {
    battle.bossEnraged = true;
    battle.bossSurgeActive = true;
    battle.log.push(`⚠️ ${aiActive.name} is enraged! Its next ability will be devastating!`);
  }
  // Speed bonus: AI 30%+ faster → +20% damage
  const speedBonus = aiActive.spd >= pa.spd * 1.3 ? 1.2 : 1;
  if (speedBonus > 1 && !battle._speedMsgThisTurn) { battle.log.push(`⚡ Foe's ${aiActive.name} is lightning-fast!`); battle._speedMsgThisTurn = true; }
  const cost = orbCost(aiActive);
  // Coach def bonus: reduce incoming damage to player
  const coachDefMult = (battle.playerCoach?.buff_type === 'def_bonus')
    ? Math.max(0.1, 1 - parseFloat(battle.playerCoach.buff_value)) : 1;

  if ((aiActive.orbs || 0) >= cost) {
    aiActive.orbs -= cost;
    let dmg = calcDamage(aiActive, pa);
    if (battle.bossSurgeActive) { dmg = Math.floor(dmg * 1.5); battle.bossSurgeActive = false; }
    dmg = Math.floor(dmg * speedBonus * coachDefMult);
    if (battle.playerGuarded) { dmg = Math.floor(dmg * 0.5); battle.log.push(`🛡️ Your guard absorbed half the damage!`); }
    const eff = typeEffectText(aiActive, pa);
    pa.current_hp = Math.max(0, pa.current_hp - dmg);
    battle.log.push(`Foe's ${aiActive.name} unleashed ${aiActive.ability_name}!${eff} Dealt ${dmg} to your ${pa.name}.`);
    applyStatus(aiActive, pa, battle);
  } else {
    const { dmg: rawDmg, crit } = calcBasicDamage(aiActive, pa);
    let dmg = Math.floor(rawDmg * speedBonus * coachDefMult);
    if (battle.playerGuarded) { dmg = Math.floor(dmg * 0.5); battle.log.push(`🛡️ Your guard absorbed half the damage!`); }
    pa.current_hp = Math.max(0, pa.current_hp - dmg);
    battle.log.push(`Foe's ${aiActive.name} attacks! Dealt ${dmg} to your ${pa.name}.${crit ? ' Critical hit!' : ''}`);
  }
  battle.playerGuarded = false;
  battle._speedMsgThisTurn = false;
  // Reset player energy attachment for the new player turn
  battle.playerEnergyAttached = false;
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── AUTH MIDDLEWARE ────────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Always pull fresh role + ban status from DB so role changes take effect immediately
    query('SELECT role, banned FROM users WHERE id=$1', [payload.id])
      .then(r => {
        if (!r.rows.length) return res.status(401).json({ error: 'User not found' });
        if (r.rows[0].banned) return res.status(403).json({ error: 'Account banned' });
        req.user = { ...payload, role: r.rows[0].role };
        next();
      })
      .catch(() => { req.user = payload; next(); }); // fall back to JWT role if DB unreachable
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

const ROLE_ORDER = ['user','mod','admin','headofstaff','owner','developer'];
function requireRole(minRole) {
  return (req, res, next) => {
    if (ROLE_ORDER.indexOf(req.user.role) < ROLE_ORDER.indexOf(minRole))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

async function logAction(adminId, action, targetId, details) {
  try { await query('INSERT INTO admin_logs (admin_id, action, target_user_id, details) VALUES ($1,$2,$3,$4)', [adminId, action, targetId, details]); }
  catch {}
}

// ─── MAINTENANCE FLAGS ────────────────────────────────────────────
const maintenanceFlags = { battle: false, packs: false, friends: false, ranked: false };
async function loadMaintenanceFlags() {
  try {
    const r = await query("SELECT key, value FROM game_config WHERE key LIKE 'maintenance_%'");
    for (const row of r.rows) {
      const feature = row.key.replace('maintenance_', '');
      if (feature in maintenanceFlags) maintenanceFlags[feature] = row.value === 'true';
    }
  } catch {}
}
function checkMaintenance(feature) {
  return (req, res, next) => {
    if (maintenanceFlags[feature]) return res.status(503).json({ error: `${feature} is currently under maintenance. Check back soon.` });
    next();
  };
}

function rankTitle(rating) {
  if (rating >= 2200) return 'Grandmaster';
  if (rating >= 2000) return 'Master';
  if (rating >= 1800) return 'Diamond';
  if (rating >= 1600) return 'Platinum';
  if (rating >= 1400) return 'Gold';
  if (rating >= 1200) return 'Silver';
  return 'Bronze';
}

// ─── DECK HELPER ─────────────────────────────────────────────────
async function getPlayerDeck(userId) {
  const deckRes = await query('SELECT card_ids FROM decks WHERE user_id=$1', [userId]);
  const cardIds = deckRes.rows[0]?.card_ids;
  if (cardIds && cardIds.length > 0) {
    const cards = await query(
      'SELECT c.* FROM cards c JOIN user_cards uc ON uc.card_id=c.id WHERE uc.user_id=$1 AND c.id = ANY($2)',
      [userId, cardIds]
    );
    if (cards.rows.length > 0) return cards.rows;
  }
  // Fallback: best cards from collection
  const random = await query(
    'SELECT c.* FROM user_cards uc JOIN cards c ON c.id=uc.card_id WHERE uc.user_id=$1 ORDER BY RANDOM() LIMIT 5',
    [userId]
  );
  let pool = random.rows;
  if (pool.length < 5) {
    const extras = await query(
      "SELECT * FROM cards WHERE rarity IN ('Common','Uncommon') ORDER BY RANDOM() LIMIT $1",
      [5 - pool.length]
    );
    pool = [...pool, ...extras.rows];
  }
  return pool;
}

// ─── PVP HELPERS ─────────────────────────────────────────────────
function getPvpStateForUser(battle, userId) {
  const isP1 = battle.player1Id === userId;
  return {
    isPvp:            true,
    ranked:           battle.ranked,
    id:               battle.id,
    opponentUsername: isP1 ? battle.player2Username : battle.player1Username,
    playerCards:      isP1 ? battle.player1Cards : battle.player2Cards,
    aiCards:          isP1 ? battle.player2Cards : battle.player1Cards,
    playerActive:     isP1 ? battle.player1Active : battle.player2Active,
    aiActive:         isP1 ? battle.player2Active : battle.player1Active,
    playerTurn:       (battle.turn === 'player1') === isP1,
    log:              battle.log,
    finished:         battle.finished,
    winner:           !battle.finished ? null : (battle.winner === (isP1 ? 'player1' : 'player2') ? 'player' : 'ai'),
    ratingResult:     battle.ratingResult ? (isP1 ? battle.ratingResult.p1 : battle.ratingResult.p2) : null,
    turnTimeLeft:     Math.max(0, 30 - Math.floor((Date.now() - battle.lastAction) / 1000)),
    playerCoach:          isP1 ? battle.p1Coach          : battle.p2Coach,
    playerHealUses:       isP1 ? battle.p1HealUses       : battle.p2HealUses,
    playerHealMax:        isP1 ? battle.p1HealMax        : battle.p2HealMax,
    playerBoosted:        isP1 ? battle.p1Boosted        : battle.p2Boosted,
    playerGuarded:        isP1 ? battle.p1Guarded        : battle.p2Guarded,
    playerEnergyAttached: isP1 ? battle.p1EnergyAttached : battle.p2EnergyAttached,
    playerVoidMode:       isP1 ? battle.p1VoidMode       : battle.p2VoidMode,
    playerVoidTurns:      isP1 ? battle.p1VoidTurns      : battle.p2VoidTurns,
    playerVoidStored:     isP1 ? battle.p1VoidStored     : battle.p2VoidStored,
    playerCombo:          0,
    bossSurgeActive:      false,
    battleChat:           (battle.battleChat || []).slice(-50),
  };
}

function executePvpAutoAttack(battle) {
  const isP1 = battle.turn === 'player1';
  const atkCards = isP1 ? battle.player1Cards : battle.player2Cards;
  const defCards = isP1 ? battle.player2Cards : battle.player1Cards;
  const atkIdx   = isP1 ? battle.player1Active : battle.player2Active;
  const defIdx   = isP1 ? battle.player2Active : battle.player1Active;
  const atkUser  = isP1 ? battle.player1Username : battle.player2Username;
  const defUser  = isP1 ? battle.player2Username : battle.player1Username;
  const attacker = atkCards[atkIdx];
  const defender = defCards[defIdx];
  const { dmg } = calcBasicDamage(attacker, defender);
  const guardKey = isP1 ? 'p2Guarded' : 'p1Guarded';
  const finalDmg = battle[guardKey] ? Math.max(1, Math.floor(dmg * 0.5)) : dmg;
  battle[guardKey] = false;
  defender.current_hp = Math.max(0, defender.current_hp - finalDmg);
  battle.log.push(`[Auto] ${atkUser}'s ${attacker.name} attacked! Dealt ${finalDmg} to ${defUser}'s ${defender.name}. (${defender.current_hp}/${defender.max_hp} HP)`);
  battle.lastAction = Date.now();
  if (defender.current_hp <= 0) {
    const next = defCards.findIndex((c,i) => i !== defIdx && c.current_hp > 0);
    if (next !== -1) {
      if (isP1) battle.player2Active = next; else battle.player1Active = next;
      battle.log.push(`${defUser}'s ${defCards[next].name} steps forward!`);
    }
  }
  if (!defCards.some(c => c.current_hp > 0)) {
    battle.finished = true;
    battle.winner = isP1 ? 'player1' : 'player2';
    battle.log.push(`${atkUser} wins! All opponent's creatures defeated!`);
    return;
  }
  battle.turn = battle.turn === 'player1' ? 'player2' : 'player1';
  // Reset energy attached for new active player
  if (battle.turn === 'player1') battle.p1EnergyAttached = false;
  else battle.p2EnergyAttached = false;
}

async function finishPvpBattle(battle) {
  try {
    const p1Won = battle.winner === 'player1';
    const coinsWin = battle.ranked ? 50 : 20;
    const winnerId = p1Won ? battle.player1Id : battle.player2Id;
    await query('UPDATE users SET coins = coins + $1 WHERE id=$2', [coinsWin, winnerId]);
    if (battle.ranked) {
      const r1s = await query('SELECT rating FROM ranked_stats WHERE user_id=$1', [battle.player1Id]);
      const r2s = await query('SELECT rating FROM ranked_stats WHERE user_id=$1', [battle.player2Id]);
      const r1 = r1s.rows[0]?.rating || 1000, r2 = r2s.rows[0]?.rating || 1000;
      const K = 32, exp1 = 1 / (1 + Math.pow(10, (r2 - r1) / 400));
      const new1 = Math.max(100, Math.round(r1 + K * ((p1Won?1:0) - exp1)));
      const new2 = Math.max(100, Math.round(r2 + K * ((p1Won?0:1) - (1-exp1))));
      const t1 = rankTitle(new1), t2 = rankTitle(new2);
      await query(
        'UPDATE ranked_stats SET rating=$1,rank_title=$2,wins=wins+$3,losses=losses+$4,season_wins=season_wins+$3,season_losses=season_losses+$4 WHERE user_id=$5',
        [new1, t1, p1Won?1:0, p1Won?0:1, battle.player1Id]
      );
      await query(
        'UPDATE ranked_stats SET rating=$1,rank_title=$2,wins=wins+$3,losses=losses+$4,season_wins=season_wins+$3,season_losses=season_losses+$4 WHERE user_id=$5',
        [new2, t2, p1Won?0:1, p1Won?1:0, battle.player2Id]
      );
      battle.ratingResult = {
        p1: { win: p1Won,  newRating: new1, title: t1, coinsEarned: p1Won ? coinsWin : 0 },
        p2: { win: !p1Won, newRating: new2, title: t2, coinsEarned: p1Won ? 0 : coinsWin },
      };
    } else {
      battle.ratingResult = {
        p1: { win: p1Won,  coinsEarned: p1Won ? coinsWin : 0 },
        p2: { win: !p1Won, coinsEarned: p1Won ? 0 : coinsWin },
      };
    }
    await query(
      'INSERT INTO matches (player1_id,player2_id,winner_id,p1_hp_left,p2_hp_left,match_log) VALUES ($1,$2,$3,$4,$5,$6)',
      [battle.player1Id, battle.player2Id, winnerId,
       battle.player1Cards.reduce((s,c)=>s+c.current_hp,0),
       battle.player2Cards.reduce((s,c)=>s+c.current_hp,0),
       JSON.stringify(battle.log)]
    );
    // Quest progress for both players
    await updateQuestProgress(battle.player1Id, 'play_pvp');
    await updateQuestProgress(battle.player2Id, 'play_pvp');
    await updateQuestProgress(battle.player1Id, 'play_battle');
    await updateQuestProgress(battle.player2Id, 'play_battle');
    if (p1Won) {
      await updateQuestProgress(battle.player1Id, 'win_pvp');
      await updateQuestProgress(battle.player1Id, 'win_battle');
      if (battle.ranked) await updateQuestProgress(battle.player1Id, 'win_pvp_ranked');
    } else {
      await updateQuestProgress(battle.player2Id, 'win_pvp');
      await updateQuestProgress(battle.player2Id, 'win_battle');
      if (battle.ranked) await updateQuestProgress(battle.player2Id, 'win_pvp_ranked');
    }
  } catch(e) { console.error('finishPvpBattle:', e); }
}

function tryMatchPlayers() {
  const queue = [...pvpQueue.values()];
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      if (queue[i].ranked === queue[j].ranked) {
        const p1 = queue[i], p2 = queue[j];
        pvpQueue.delete(p1.userId); pvpQueue.delete(p2.userId);
        const battleId = `pvp_${p1.userId}_${p2.userId}_${Date.now()}`;
        const toSlot = (cards, traitMap, orbStart) => cards.map(c => {
          const trait = traitMap?.[c.id] || null;
          const atkMod = trait && trait.special_type !== 'void' ? parseFloat(trait.atk_mod || 0) : 0;
          const defMod = trait && trait.special_type !== 'void' ? parseFloat(trait.def_mod || 0) : 0;
          return {
            ...c,
            current_hp: c.hp, max_hp: c.hp, status: null, orbs: orbStart || 0,
            atk: Math.round(c.atk * (1 + atkMod)),
            def: Math.round(c.def * (1 + defMod)),
            trait: trait ? { id: trait.id, name: trait.name, rarity: trait.rarity, special_type: trait.special_type || null } : null,
          };
        });
        const mkCoach = c => c ? { id: c.id, name: c.name, portrait: c.portrait, buff_type: c.buff_type, buff_value: parseFloat(c.buff_value), quotes: c.quote_lines } : null;
        const battle = {
          id: battleId,
          player1Id: p1.userId, player2Id: p2.userId,
          player1Username: p1.username, player2Username: p2.username,
          player1Cards: toSlot(p1.cards, p1.traitMap, p1.orbStart),
          player2Cards: toSlot(p2.cards, p2.traitMap, p2.orbStart),
          player1Active: 0, player2Active: 0,
          turn: 'player1',
          log: [`⚔️ Match found: ${p1.username} vs ${p2.username}!`, `${p1.username} goes first!`],
          finished: false, winner: null,
          ranked: p1.ranked, createdAt: Date.now(), lastAction: Date.now(), ratingResult: null,
          p1Coach: mkCoach(p1.coach), p2Coach: mkCoach(p2.coach),
          p1HealUses: 0, p1HealMax: p1.healMax || 2,
          p2HealUses: 0, p2HealMax: p2.healMax || 2,
          p1Boosted: false, p2Boosted: false,
          p1Guarded: false, p2Guarded: false,
          p1EnergyAttached: false, p2EnergyAttached: false,
          p1VoidMode: false, p1VoidTurns: 0, p1VoidStored: 0,
          p2VoidMode: false, p2VoidTurns: 0, p2VoidStored: 0,
          battleChat: [],
        };
        pvpBattles.set(battleId, battle);
        userToBattle.set(p1.userId, battleId);
        userToBattle.set(p2.userId, battleId);
        return;
      }
    }
  }
}

// Auto-timeout inactive turns (30s)
setInterval(() => {
  for (const [battleId, battle] of pvpBattles.entries()) {
    if (battle.finished) continue;
    if (Date.now() - battle.lastAction > 30000) {
      executePvpAutoAttack(battle);
      if (battle.finished) {
        finishPvpBattle(battle).catch(console.error);
        setTimeout(() => { pvpBattles.delete(battleId); userToBattle.delete(battle.player1Id); userToBattle.delete(battle.player2Id); }, 120000);
      }
    }
  }
}, 5000);

// ─── AUTH ROUTES ────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-20 alphanumeric characters or underscores' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const exists = await query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Username already taken' });
    const hash = await bcrypt.hash(password, 10);
    const userRes = await query('INSERT INTO users (username, password_hash) VALUES ($1,$2) RETURNING id, username, role, coins, avatar_color, bio, created_at', [username, hash]);
    const user = userRes.rows[0];
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
    await query('INSERT INTO ranked_stats (user_id) VALUES ($1)', [user.id]);
    // Give 5 starter cards
    const starters = await query("SELECT id FROM cards WHERE rarity IN ('Common','Uncommon') ORDER BY RANDOM() LIMIT 5");
    for (const c of starters.rows) {
      await query('INSERT INTO user_cards (user_id, card_id) VALUES ($1,$2) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_cards.quantity + 1', [user.id, c.id]);
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, coins: user.coins, avatar_color: user.avatar_color, bio: user.bio } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const result = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    if (user.banned) return res.status(403).json({ error: `Account banned: ${user.ban_reason || 'No reason given'}` });
    if (user.timeout_until && new Date(user.timeout_until) > new Date()) {
      const remaining = Math.ceil((new Date(user.timeout_until) - new Date()) / 60000);
      const hrs = Math.floor(remaining / 60), mins = remaining % 60;
      return res.status(403).json({ error: `Account timed out. Expires in ${hrs > 0 ? hrs + 'h ' : ''}${mins}m` });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, coins: user.coins, avatar_color: user.avatar_color, bio: user.bio } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const result = await query('SELECT id, username, role, coins, avatar_color, avatar_img, bio, created_at, banned, custom_title FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CARDS ROUTES ────────────────────────────────────────────────
app.get('/api/cards', async (req, res) => {
  try {
    const { page = 1, limit = 20, type, rarity, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = [];
    let params = [];
    let idx = 1;
    if (type) { where.push(`type = $${idx++}`); params.push(type); }
    if (rarity) { where.push(`rarity = $${idx++}`); params.push(rarity); }
    if (search) { where.push(`name ILIKE $${idx++}`); params.push('%' + search + '%'); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = await query(`SELECT COUNT(*) FROM cards ${whereStr}`, params);
    const cards = await query(`SELECT * FROM cards ${whereStr} ORDER BY id LIMIT $${idx} OFFSET $${idx+1}`, [...params, parseInt(limit), offset]);
    res.json({ cards: cards.rows, total: parseInt(total.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cards/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Card not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/collection', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT c.*, uc.quantity, uc.obtained_at, uc.print_number
      FROM user_cards uc JOIN cards c ON c.id = uc.card_id
      WHERE uc.user_id = $1
      ORDER BY c.id
    `, [req.user.id]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: roll rarity from a cumulative odds map
function rollRarityFromOdds(odds) {
  // odds: { "Mythic,Prism": 2, "Numbered,Full_Art": 3, ... }
  const roll = Math.random() * 100;
  let cursor = 0;
  for (const [rarities, pct] of Object.entries(odds)) {
    cursor += Number(pct);
    if (roll < cursor) return rarities.split(',').map(r => `'${r.trim()}'`).join(',');
  }
  // fallback to last tier
  const lastKey = Object.keys(odds).at(-1);
  return lastKey.split(',').map(r => `'${r.trim()}'`).join(',');
}

// Helper: pull one card given a rarity SQL fragment and optional card_filter
async function pullOneCard(rarityFilter, cardFilter) {
  // If specific card IDs are pinned to this pack, ignore rarity tiers entirely
  if (cardFilter?.card_ids?.length) {
    const placeholders = cardFilter.card_ids.map((_, i) => `$${i + 1}`).join(',');
    return query(
      `SELECT * FROM cards WHERE id IN (${placeholders}) AND (print_limit IS NULL OR print_count < print_limit) ORDER BY RANDOM() LIMIT 1`,
      cardFilter.card_ids
    );
  }
  let extraWhere = '';
  const params = [];
  if (cardFilter) {
    if (cardFilter.set_name) { params.push(cardFilter.set_name); extraWhere += ` AND set_name = $${params.length}`; }
    if (cardFilter.types?.length) {
      const placeholders = cardFilter.types.map((_, i) => `$${params.length + i + 1}`).join(',');
      params.push(...cardFilter.types);
      extraWhere += ` AND type IN (${placeholders})`;
    }
  }
  return query(
    `SELECT * FROM cards WHERE rarity IN (${rarityFilter}) AND (print_limit IS NULL OR print_count < print_limit)${extraWhere} ORDER BY RANDOM() LIMIT 1`,
    params
  );
}

app.post('/api/packs/open', auth, checkMaintenance('packs'), async (req, res) => {
  try {
    const { packType = 'basic' } = req.body;
    const BUILT_IN_ODDS = {
      basic:  { 'Mythic,Prism':0.5, 'Numbered,Full_Art':1.5, 'Ultra_Rare,Secret_Rare,Parallel':4, 'Rare':18, 'Uncommon':25, 'Common':50.5 },
      rare:   { 'Mythic,Prism':2,   'Numbered,Full_Art':6,   'Ultra_Rare,Secret_Rare,Parallel':26, 'Rare':47, 'Uncommon':16, 'Common':3 },
      ultra:  { 'Mythic,Prism':6,   'Numbered,Full_Art':15,  'Ultra_Rare,Secret_Rare,Parallel':49, 'Rare':22, 'Uncommon':5.5, 'Common':2.5 },
      mythic: { 'Mythic,Prism':49.5,'Numbered,Secret_Rare':27,'Full_Art,Ultra_Rare':14, 'Parallel':5.5, 'Rare':2.5, 'Uncommon':0.7, 'Common':0.3 },
    };
    const PACK_CONFIG = { basic:{cost:100,count:5}, rare:{cost:750,count:5}, ultra:{cost:2500,count:7}, mythic:{cost:8000,count:10} };

    let cfg, oddsMap, cardFilter = null;
    if (PACK_CONFIG[packType]) {
      cfg = PACK_CONFIG[packType];
      oddsMap = BUILT_IN_ODDS[packType];
    } else {
      // Check custom packs
      const cpRes = await query('SELECT * FROM custom_packs WHERE pack_id=$1 AND active=true', [packType]);
      if (!cpRes.rows.length) return res.status(404).json({ error: 'Unknown pack type' });
      const cp = cpRes.rows[0];
      cfg = { cost: cp.cost, count: cp.count };
      oddsMap = cp.odds;
      cardFilter = cp.card_filter;
    }

    const userRes = await query('SELECT coins FROM users WHERE id = $1', [req.user.id]);
    if (userRes.rows[0].coins < cfg.cost) return res.status(400).json({ error: `Not enough coins (need ${cfg.cost})` });
    await query('UPDATE users SET coins = coins - $1 WHERE id = $2', [cfg.cost, req.user.id]);
    const pulled = [];
    for (let i = 0; i < cfg.count; i++) {
      const rarityFilter = rollRarityFromOdds(oddsMap);
      let printNumber = null;
      const card = await pullOneCard(rarityFilter, cardFilter);
      if (card.rows.length) {
        const c = card.rows[0];
        if (c.is_numbered && c.print_limit !== null) {
          const claim = await query(
            'UPDATE cards SET print_count = print_count + 1 WHERE id = $1 AND print_count < print_limit RETURNING print_count',
            [c.id]
          );
          if (!claim.rows.length) { i--; continue; }
          printNumber = claim.rows[0].print_count;
        }
        await query(
          'INSERT INTO user_cards (user_id, card_id, print_number) VALUES ($1,$2,$3) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_cards.quantity + 1',
          [req.user.id, c.id, printNumber]
        );
        pulled.push({ ...c, print_number: printNumber });
      }
    }

    await updateQuestProgress(req.user.id, 'open_pack');
    res.json({ cards: pulled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/daily', auth, async (req, res) => {
  try {
    const userRes = await query('SELECT last_daily FROM users WHERE id = $1', [req.user.id]);
    const last = userRes.rows[0].last_daily;
    const now = new Date();
    if (last) {
      const diff = now - new Date(last);
      if (diff < 86400000) return res.status(400).json({ error: 'Daily pack already claimed', nextIn: 86400000 - diff });
    }
    await query('UPDATE users SET last_daily = NOW() WHERE id = $1', [req.user.id]);
    const card = await query("SELECT * FROM cards WHERE rarity IN ('Common','Uncommon','Rare') ORDER BY RANDOM() LIMIT 5");
    for (const c of card.rows) {
      await query('INSERT INTO user_cards (user_id, card_id) VALUES ($1,$2) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_cards.quantity + 1', [req.user.id, c.id]);
    }
    await query('UPDATE users SET coins = coins + 50 WHERE id = $1', [req.user.id]);
    res.json({ cards: card.rows, coins: 50 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/tutorial-complete', auth, async (req, res) => {
  try {
    const userRes = await query('SELECT tutorial_done FROM users WHERE id=$1', [req.user.id]);
    if (userRes.rows[0].tutorial_done) return res.status(400).json({ error: 'Tutorial reward already claimed' });
    await query('UPDATE users SET tutorial_done=true WHERE id=$1', [req.user.id]);
    // Reward: 150 coins + 3 random cards
    await query('UPDATE users SET coins=coins+150 WHERE id=$1', [req.user.id]);
    const cards = await query("SELECT * FROM cards WHERE rarity IN ('Common','Uncommon','Rare') ORDER BY RANDOM() LIMIT 3");
    for (const c of cards.rows) {
      await query('INSERT INTO user_cards (user_id,card_id) VALUES ($1,$2) ON CONFLICT (user_id,card_id) DO UPDATE SET quantity=user_cards.quantity+1', [req.user.id, c.id]);
    }
    res.json({ coins: 150, cards: cards.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FRIENDS ROUTES ─────────────────────────────────────────────
app.get('/api/friends', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT f.id, f.status, f.created_at,
        CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END AS other_user_id,
        CASE WHEN f.user_id = $1 THEN true ELSE false END AS i_sent_it,
        u.username, u.avatar_color, u.avatar_img, u.role,
        rs.rating, rs.rank_title
      FROM friends f
      JOIN users u ON u.id = (CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END)
      LEFT JOIN ranked_stats rs ON rs.user_id = u.id
      WHERE (f.user_id = $1 OR f.friend_id = $1)
      ORDER BY f.status, u.username
    `, [req.user.id]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/friends/request/:username', auth, checkMaintenance('friends'), async (req, res) => {
  try {
    const target = await query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [req.params.username]);
    if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
    const tid = target.rows[0].id;
    if (tid === req.user.id) return res.status(400).json({ error: 'Cannot friend yourself' });
    const exists = await query('SELECT id FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [req.user.id, tid]);
    if (exists.rows.length) return res.status(400).json({ error: 'Friend request already exists' });
    await query('INSERT INTO friends (user_id, friend_id, status) VALUES ($1,$2,$3)', [req.user.id, tid, 'pending']);
    // Create notification for the recipient
    await query(
      "INSERT INTO notifications (user_id, type, message, from_user_id) VALUES ($1,'friend_request',$2,$3)",
      [tid, `${req.user.username} sent you a friend request`, req.user.id]
    ).catch(() => {});
    res.json({ message: 'Friend request sent' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/friends/:id/accept', auth, async (req, res) => {
  try {
    const result = await query('UPDATE friends SET status = $1 WHERE id = $2 AND friend_id = $3 RETURNING *', ['accepted', req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Request not found' });
    // Notify original requester
    const fr = result.rows[0];
    await query(
      "INSERT INTO notifications (user_id, type, message, from_user_id) VALUES ($1,'friend_accepted',$2,$3)",
      [fr.user_id, `${req.user.username} accepted your friend request`, req.user.id]
    ).catch(() => {});
    // Mark the incoming friend_request notification as read
    await query("UPDATE notifications SET read=true WHERE user_id=$1 AND from_user_id=$2 AND type='friend_request'", [req.user.id, fr.user_id]).catch(() => {});
    res.json({ message: 'Friend accepted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/friends/:id', auth, async (req, res) => {
  try {
    await query('DELETE FROM friends WHERE id = $1 AND (user_id = $2 OR friend_id = $2)', [req.params.id, req.user.id]);
    res.json({ message: 'Removed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DIRECT MESSAGES ─────────────────────────────────────────────
// Must be before /:userId to avoid route collision
app.get('/api/dm/unread', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT sender_id, COUNT(*) AS count FROM direct_messages WHERE recipient_id=$1 AND read=false GROUP BY sender_id`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dm/:userId', auth, async (req, res) => {
  try {
    const otherId = parseInt(req.params.userId);
    const fr = await query(
      `SELECT 1 FROM friends WHERE ((user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)) AND status='accepted'`,
      [req.user.id, otherId]
    );
    if (!fr.rows.length) return res.status(403).json({ error: 'Not friends' });
    const msgs = await query(
      `SELECT dm.id, dm.sender_id, dm.recipient_id, dm.message, dm.read, dm.created_at, u.username
       FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
       WHERE (dm.sender_id=$1 AND dm.recipient_id=$2) OR (dm.sender_id=$2 AND dm.recipient_id=$1)
       ORDER BY dm.created_at ASC LIMIT 200`,
      [req.user.id, otherId]
    );
    await query(`UPDATE direct_messages SET read=true WHERE recipient_id=$1 AND sender_id=$2 AND read=false`, [req.user.id, otherId]);
    res.json(msgs.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dm/:userId', auth, async (req, res) => {
  try {
    const otherId = parseInt(req.params.userId);
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    if (message.length > 500) return res.status(400).json({ error: 'Message too long (max 500 chars)' });
    const fr = await query(
      `SELECT 1 FROM friends WHERE ((user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)) AND status='accepted'`,
      [req.user.id, otherId]
    );
    if (!fr.rows.length) return res.status(403).json({ error: 'Not friends' });
    const result = await query(
      `INSERT INTO direct_messages (sender_id, recipient_id, message) VALUES ($1,$2,$3) RETURNING *`,
      [req.user.id, otherId, message.trim()]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RANKED ROUTES ───────────────────────────────────────────────
app.get('/api/ranked/leaderboard', async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.username, u.avatar_color, u.avatar_img, rs.wins, rs.losses, rs.rating, rs.rank_title, rs.top500
      FROM ranked_stats rs JOIN users u ON u.id = rs.user_id
      WHERE u.banned = false
      ORDER BY rs.rating DESC
      LIMIT 500
    `);
    res.json(result.rows.map((r, i) => ({ ...r, rank: i + 1 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ranked/me', auth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM ranked_stats WHERE user_id = $1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Stats not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ranked/match', auth, checkMaintenance('ranked'), async (req, res) => {
  try {
    const { opponent_id, won, p1_hp_left, p2_hp_left, match_log } = req.body;
    const loser_id = won ? (opponent_id || 0) : req.user.id;
    const winner_id = won ? req.user.id : (opponent_id || 0);
    await query('INSERT INTO matches (player1_id, player2_id, winner_id, p1_hp_left, p2_hp_left, match_log) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, opponent_id || null, winner_id, p1_hp_left || 0, p2_hp_left || 0, JSON.stringify(match_log || [])]);
    // ELO update
    const myStats = await query('SELECT rating FROM ranked_stats WHERE user_id = $1', [req.user.id]);
    const myRating = myStats.rows[0]?.rating || 1000;
    const K = 32;
    const expected = 1 / (1 + Math.pow(10, (1000 - myRating) / 400));
    const score = won ? 1 : 0;
    const newRating = Math.max(100, Math.round(myRating + K * (score - expected)));
    const title = rankTitle(newRating);
    await query('UPDATE ranked_stats SET rating=$1, rank_title=$2, wins=wins+$3, losses=losses+$4, season_wins=season_wins+$3, season_losses=season_losses+$4 WHERE user_id=$5',
      [newRating, title, won ? 1 : 0, won ? 0 : 1, req.user.id]);
    // Update top500
    const pos = await query('SELECT COUNT(*) FROM ranked_stats WHERE rating > $1', [newRating]);
    const isTop500 = parseInt(pos.rows[0].count) < 500;
    await query('UPDATE ranked_stats SET top500=$1 WHERE user_id=$2', [isTop500, req.user.id]);
    // Give coins for win
    if (won) await query('UPDATE users SET coins = coins + 30 WHERE id = $1', [req.user.id]);
    res.json({ newRating, title, isTop500, coinsEarned: won ? 30 : 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NOTIFICATION ROUTES ─────────────────────────────────────────
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT n.*, u.username as from_username, u.avatar_color as from_avatar, u.avatar_img as from_avatar_img
       FROM notifications n
       LEFT JOIN users u ON u.id = n.from_user_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC LIMIT 30`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await query('UPDATE notifications SET read=true WHERE user_id=$1', [req.user.id]);
    res.json({ message: 'All marked read' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await query('UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ message: 'Marked read' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TRADE ROUTES ─────────────────────────────────────────────────

// List all trades involving the current user
app.get('/api/trades', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT t.*,
        fu.username AS from_username, fu.avatar_color AS from_color,
        tu.username AS to_username,   tu.avatar_color AS to_color
      FROM trades t
      JOIN users fu ON fu.id = t.from_user_id
      JOIN users tu ON tu.id = t.to_user_id
      WHERE (t.from_user_id = $1 OR t.to_user_id = $1)
        AND t.status = 'pending'
      ORDER BY t.created_at DESC
      LIMIT 50
    `, [req.user.id]);

    // Enrich with card info
    const trades = await Promise.all(result.rows.map(async t => {
      const offered   = t.offered_card_ids?.length
        ? (await query('SELECT * FROM cards WHERE id = ANY($1)', [t.offered_card_ids])).rows : [];
      const requested = t.requested_card_ids?.length
        ? (await query('SELECT * FROM cards WHERE id = ANY($1)', [t.requested_card_ids])).rows : [];
      return { ...t, offeredCards: offered, requestedCards: requested };
    }));

    res.json(trades);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Browse another user's collection (for trade targeting)
app.get('/api/trades/user/:username/collection', auth, async (req, res) => {
  try {
    const uRes = await query('SELECT id FROM users WHERE username=$1', [req.params.username]);
    if (!uRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const targetId = uRes.rows[0].id;
    const { search = '', page = 1 } = req.query;
    const limit = 24, offset = (page - 1) * limit;
    const searchClause = search ? `AND (c.name ILIKE $4 OR c.type ILIKE $4)` : '';
    const params = search
      ? [targetId, limit, offset, `%${search}%`]
      : [targetId, limit, offset];
    const rows = await query(`
      SELECT c.*, uc.quantity FROM user_cards uc
      JOIN cards c ON c.id = uc.card_id
      WHERE uc.user_id = $1 ${searchClause}
      ORDER BY c.rarity DESC, c.name
      LIMIT $2 OFFSET $3
    `, params);
    const total = await query(`
      SELECT COUNT(*) FROM user_cards uc JOIN cards c ON c.id=uc.card_id
      WHERE uc.user_id=$1 ${searchClause}
    `, search ? [targetId, `%${search}%`] : [targetId]);
    res.json({ cards: rows.rows, total: parseInt(total.rows[0].count), page: parseInt(page) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a trade offer
app.post('/api/trades', auth, async (req, res) => {
  try {
    const { toUsername, offeredCardIds, requestedCardIds, message = '' } = req.body;
    if (!toUsername) return res.status(400).json({ error: 'No target user specified' });
    if (!offeredCardIds?.length) return res.status(400).json({ error: 'You must offer at least one card' });
    if (!requestedCardIds?.length) return res.status(400).json({ error: 'You must request at least one card' });

    const toRes = await query('SELECT id FROM users WHERE username=$1', [toUsername]);
    if (!toRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const toId = toRes.rows[0].id;
    if (toId === req.user.id) return res.status(400).json({ error: "You can't trade with yourself" });

    // Verify sender owns all offered cards
    for (const cid of offeredCardIds) {
      const own = await query('SELECT quantity FROM user_cards WHERE user_id=$1 AND card_id=$2', [req.user.id, cid]);
      if (!own.rows.length || own.rows[0].quantity < 1)
        return res.status(400).json({ error: `You don't own card #${cid}` });
    }
    // Verify target owns all requested cards
    for (const cid of requestedCardIds) {
      const own = await query('SELECT quantity FROM user_cards WHERE user_id=$1 AND card_id=$2', [toId, cid]);
      if (!own.rows.length || own.rows[0].quantity < 1)
        return res.status(400).json({ error: `They don't own card #${cid}` });
    }

    // Limit pending trades
    const pending = await query('SELECT COUNT(*) FROM trades WHERE from_user_id=$1 AND status=$2', [req.user.id, 'pending']);
    if (parseInt(pending.rows[0].count) >= 10)
      return res.status(400).json({ error: 'You have 10 pending trades already. Wait for some to resolve.' });

    const fromUser = await query('SELECT username FROM users WHERE id=$1', [req.user.id]);
    const trade = await query(`
      INSERT INTO trades (from_user_id, to_user_id, offered_card_ids, requested_card_ids, message)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.user.id, toId, offeredCardIds, requestedCardIds, message.slice(0,200)]);

    // Notify recipient
    await query(
      `INSERT INTO notifications (user_id, type, message, from_user_id) VALUES ($1,'trade_offer',$2,$3)`,
      [toId, `${fromUser.rows[0].username} sent you a trade offer!`, req.user.id]
    );

    res.json(trade.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Accept a trade
app.post('/api/trades/:id/accept', auth, async (req, res) => {
  try {
    const tradeRes = await query('SELECT * FROM trades WHERE id=$1 AND to_user_id=$2 AND status=$3',
      [req.params.id, req.user.id, 'pending']);
    if (!tradeRes.rows.length) return res.status(404).json({ error: 'Trade not found or already resolved' });
    const trade = tradeRes.rows[0];

    // Re-verify ownership before executing
    for (const cid of trade.offered_card_ids) {
      const own = await query('SELECT quantity FROM user_cards WHERE user_id=$1 AND card_id=$2', [trade.from_user_id, cid]);
      if (!own.rows.length || own.rows[0].quantity < 1)
        return res.status(400).json({ error: 'Sender no longer owns an offered card — trade cancelled.' });
    }
    for (const cid of trade.requested_card_ids) {
      const own = await query('SELECT quantity FROM user_cards WHERE user_id=$1 AND card_id=$2', [req.user.id, cid]);
      if (!own.rows.length || own.rows[0].quantity < 1)
        return res.status(400).json({ error: "You no longer own a requested card." });
    }

    // Transfer offered cards: from_user → to_user
    for (const cid of trade.offered_card_ids) {
      await query('UPDATE user_cards SET quantity = quantity - 1 WHERE user_id=$1 AND card_id=$2', [trade.from_user_id, cid]);
      await query('DELETE FROM user_cards WHERE user_id=$1 AND card_id=$2 AND quantity <= 0', [trade.from_user_id, cid]);
      await query(`
        INSERT INTO user_cards (user_id, card_id, quantity) VALUES ($1,$2,1)
        ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_cards.quantity + 1
      `, [req.user.id, cid]);
    }
    // Transfer requested cards: to_user → from_user
    for (const cid of trade.requested_card_ids) {
      await query('UPDATE user_cards SET quantity = quantity - 1 WHERE user_id=$1 AND card_id=$2', [req.user.id, cid]);
      await query('DELETE FROM user_cards WHERE user_id=$1 AND card_id=$2 AND quantity <= 0', [req.user.id, cid]);
      await query(`
        INSERT INTO user_cards (user_id, card_id, quantity) VALUES ($1,$2,1)
        ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_cards.quantity + 1
      `, [trade.from_user_id, cid]);
    }

    await query('UPDATE trades SET status=$1, resolved_at=NOW() WHERE id=$2', ['accepted', trade.id]);
    // Cancel any other pending trades involving the same cards
    await query(`UPDATE trades SET status='cancelled', resolved_at=NOW()
      WHERE id != $1 AND status='pending'
      AND (from_user_id=$2 OR to_user_id=$2 OR from_user_id=$3 OR to_user_id=$3)
    `, [trade.id, trade.from_user_id, req.user.id]);

    const accepterName = await query('SELECT username FROM users WHERE id=$1', [req.user.id]);
    await query(`INSERT INTO notifications (user_id, type, message, from_user_id) VALUES ($1,'trade_accepted',$2,$3)`,
      [trade.from_user_id, `${accepterName.rows[0].username} accepted your trade offer!`, req.user.id]);

    res.json({ message: 'Trade accepted!' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Decline a trade
app.post('/api/trades/:id/decline', auth, async (req, res) => {
  try {
    const tradeRes = await query(
      'SELECT * FROM trades WHERE id=$1 AND (to_user_id=$2 OR from_user_id=$2) AND status=$3',
      [req.params.id, req.user.id, 'pending']
    );
    if (!tradeRes.rows.length) return res.status(404).json({ error: 'Trade not found' });
    const trade = tradeRes.rows[0];
    await query('UPDATE trades SET status=$1, resolved_at=NOW() WHERE id=$2', ['declined', trade.id]);

    const declinerName = await query('SELECT username FROM users WHERE id=$1', [req.user.id]);
    const notifyUserId = req.user.id === trade.from_user_id ? trade.to_user_id : trade.from_user_id;
    const verb = req.user.id === trade.to_user_id ? 'declined' : 'cancelled';
    await query(`INSERT INTO notifications (user_id, type, message, from_user_id) VALUES ($1,'trade_declined',$2,$3)`,
      [notifyUserId, `${declinerName.rows[0].username} ${verb} a trade offer.`, req.user.id]);

    res.json({ message: 'Trade declined.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── COACH ROUTES ─────────────────────────────────────────────────

app.get('/api/coaches', auth, async (req, res) => {
  try {
    const [owned, userRow] = await Promise.all([
      query(`SELECT uc.id AS user_coach_id, c.*, uc.obtained_at
             FROM user_coaches uc JOIN coaches c ON c.id = uc.coach_id
             WHERE uc.user_id = $1 ORDER BY uc.obtained_at DESC`, [req.user.id]),
      query('SELECT equipped_coach_id FROM users WHERE id=$1', [req.user.id]),
    ]);
    res.json({ coaches: owned.rows, equippedId: userRow.rows[0]?.equipped_coach_id || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/coaches/equip/:id', auth, async (req, res) => {
  try {
    const coachId = parseInt(req.params.id);
    if (isNaN(coachId)) return res.status(400).json({ error: 'Invalid coach ID' });
    if (coachId === 0) {
      await query('UPDATE users SET equipped_coach_id = NULL WHERE id=$1', [req.user.id]);
      return res.json({ message: 'Coach unequipped' });
    }
    const own = await query('SELECT 1 FROM user_coaches WHERE user_id=$1 AND coach_id=$2', [req.user.id, coachId]);
    if (!own.rows.length) return res.status(403).json({ error: 'You do not own this coach' });
    await query('UPDATE users SET equipped_coach_id = $1 WHERE id=$2', [coachId, req.user.id]);
    res.json({ message: 'Coach equipped' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/coach-packs/open', auth, async (req, res) => {
  try {
    const COST = 500;
    const userRes = await query('SELECT coins FROM users WHERE id=$1', [req.user.id]);
    if (userRes.rows[0].coins < COST) return res.status(400).json({ error: `Not enough coins (need ${COST})` });
    await query('UPDATE users SET coins = coins - $1 WHERE id=$2', [COST, req.user.id]);
    // Roll rarity
    const r = Math.random();
    let rarity;
    if (r < 0.60)      rarity = 'Common';
    else if (r < 0.85) rarity = 'Rare';
    else if (r < 0.97) rarity = 'Epic';
    else               rarity = 'Legendary';
    const coachRes = await query('SELECT * FROM coaches WHERE rarity=$1 ORDER BY RANDOM() LIMIT 1', [rarity]);
    if (!coachRes.rows.length) return res.status(500).json({ error: 'No coaches found for that rarity' });
    const ch = coachRes.rows[0];
    await query('INSERT INTO user_coaches (user_id, coach_id) VALUES ($1,$2)', [req.user.id, ch.id]);
    res.json({ coach: { id: ch.id, name: ch.name, portrait: ch.portrait, rarity: ch.rarity, description: ch.description, buff_type: ch.buff_type, buff_value: parseFloat(ch.buff_value) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TRAIT ROUTES ─────────────────────────────────────────────────

app.get('/api/traits', auth, async (req, res) => {
  try {
    const [owned, equipped] = await Promise.all([
      query(`SELECT ut.id AS user_trait_id, t.*, ut.obtained_at
             FROM user_traits ut JOIN traits t ON t.id = ut.trait_id
             WHERE ut.user_id=$1 ORDER BY ut.obtained_at DESC`, [req.user.id]),
      query(`SELECT uct.card_id, t.id, t.name, t.rarity, t.special_type
             FROM user_card_traits uct JOIN traits t ON t.id = uct.trait_id
             WHERE uct.user_id=$1`, [req.user.id]),
    ]);
    // Build a map of cardId -> trait info
    const cardTraits = {};
    for (const r of equipped.rows) cardTraits[r.card_id] = r;
    res.json({ traits: owned.rows, cardTraits });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/traits/equip', auth, async (req, res) => {
  try {
    const { traitId, cardId } = req.body;
    if (!traitId || !cardId) return res.status(400).json({ error: 'traitId and cardId required' });
    // Verify user owns the trait
    const ownTrait = await query('SELECT id FROM user_traits WHERE user_id=$1 AND trait_id=$2 LIMIT 1', [req.user.id, traitId]);
    if (!ownTrait.rows.length) return res.status(403).json({ error: 'You do not own this trait' });
    // Verify user owns the card
    const ownCard = await query('SELECT 1 FROM user_cards WHERE user_id=$1 AND card_id=$2', [req.user.id, cardId]);
    if (!ownCard.rows.length) return res.status(403).json({ error: 'You do not own this card' });
    // Check card doesn't already have a trait (permanent)
    const existing = await query('SELECT trait_id FROM user_card_traits WHERE user_id=$1 AND card_id=$2', [req.user.id, cardId]);
    if (existing.rows.length) return res.status(400).json({ error: 'This card already has a trait equipped permanently' });
    // Equip
    await query('INSERT INTO user_card_traits (user_id, card_id, trait_id) VALUES ($1,$2,$3)', [req.user.id, cardId, traitId]);
    // Consume the trait from user_traits
    await query('DELETE FROM user_traits WHERE id=$1', [ownTrait.rows[0].id]);
    const t = await query('SELECT name FROM traits WHERE id=$1', [traitId]);
    res.json({ message: `${t.rows[0]?.name || 'Trait'} permanently equipped to card!` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NEWS ROUTES ──────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  try {
    const result = await query(
      'SELECT n.*, u.username as author_name FROM news n JOIN users u ON u.id=n.author_id ORDER BY n.created_at DESC LIMIT 20'
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BATTLE ROUTES (SERVER-AUTHORITATIVE) ────────────────────────
app.post('/api/battle/start', auth, checkMaintenance('battle'), async (req, res) => {
  try {
    // Use saved deck, or fall back to random collection
    let playerPool = await getPlayerDeck(req.user.id);
    // AI gets 5 random cards of similar tier
    const aiRes = await query("SELECT * FROM cards ORDER BY RANDOM() LIMIT 5");
    const aiPool = aiRes.rows;

    // Load equipped coach
    const coachRes = await query(
      'SELECT c.* FROM coaches c JOIN users u ON u.equipped_coach_id = c.id WHERE u.id = $1',
      [req.user.id]
    );
    const coach = coachRes.rows[0] || null;
    const orbStart = (coach?.buff_type === 'orb_start') ? parseInt(coach.buff_value) : 0;
    const maxHealUses = 2 + ((coach?.buff_type === 'heal_bonus') ? parseInt(coach.buff_value) : 0);

    // Load card traits for player's cards
    const cardIds = playerPool.map(c => c.id);
    const traitRes = cardIds.length
      ? await query(
          'SELECT uct.card_id, t.* FROM user_card_traits uct JOIN traits t ON t.id = uct.trait_id WHERE uct.user_id=$1 AND uct.card_id = ANY($2)',
          [req.user.id, cardIds]
        )
      : { rows: [] };
    const traitMap = {};
    for (const r of traitRes.rows) traitMap[r.card_id] = r;

    const toSlot = (cards, applyTraits = false) => cards.map(c => {
      const trait = applyTraits ? (traitMap[c.id] || null) : null;
      const atkMod = trait && trait.special_type !== 'void' ? parseFloat(trait.atk_mod || 0) : 0;
      const defMod = trait && trait.special_type !== 'void' ? parseFloat(trait.def_mod || 0) : 0;
      return {
        ...c,
        current_hp: c.hp,
        status: null,
        orbs: orbStart,
        trait: trait ? { id: trait.id, name: trait.name, rarity: trait.rarity, special_type: trait.special_type || null } : null,
        atk: Math.round(c.atk * (1 + atkMod)),
        def: Math.round(c.def * (1 + defMod)),
      };
    });

    const battle = {
      id: `${req.user.id}_${Date.now()}`,
      userId: req.user.id,
      playerCards: toSlot(playerPool, true),
      aiCards:     toSlot(aiPool, false),
      playerActive: 0,
      aiActive:     0,
      playerTurn:   true,
      log:          ['The battle begins! You have 2 minutes. Attach Energy, Boost, Heal, or Strike!'],
      finished:     false,
      winner:       null,
      createdAt:    Date.now(),
      startedAt:    Date.now(),
      timeLimit:    120000,
      playerGuarded:        false,
      playerCombo:          0,
      playerEnergyAttached: false,
      playerHealUses:       0,
      playerHealMax:        maxHealUses,
      playerBoosted:        false,
      bossEnraged:          false,
      bossSurgeActive:      false,
      playerCoach:          coach ? { id: coach.id, name: coach.name, portrait: coach.portrait, buff_type: coach.buff_type, buff_value: parseFloat(coach.buff_value), quotes: coach.quote_lines } : null,
      playerVoidMode:       false,
      playerVoidTurns:      0,
      playerVoidStored:     0,
    };

    activeBattles.set(req.user.id, battle);
    res.json(battleView(battle));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/battle/state', auth, (req, res) => {
  const battle = activeBattles.get(req.user.id);
  if (!battle) return res.status(404).json({ error: 'No active battle' });
  res.json(battleView(battle));
});

app.post('/api/battle/action', auth, async (req, res) => {
  try {
    const battle = activeBattles.get(req.user.id);
    if (!battle)           return res.status(404).json({ error: 'No active battle. Start one first.' });
    if (battle.finished)   return res.status(400).json({ error: 'Battle already finished' });
    if (!battle.playerTurn) return res.status(400).json({ error: 'Not your turn' });

    const { action, switchTo } = req.body;

    // Check time limit
    const elapsed = Date.now() - (battle.startedAt || battle.createdAt);
    if (elapsed >= (battle.timeLimit || 120000) && !battle.finished) {
      // Resolve by most cards alive, then most HP
      const pAliveCount = battle.playerCards.filter(c => c.current_hp > 0).length;
      const aAliveCount = battle.aiCards.filter(c => c.current_hp > 0).length;
      const pHP = battle.playerCards.reduce((s,c) => s + c.current_hp, 0);
      const aHP = battle.aiCards.reduce((s,c) => s + c.current_hp, 0);
      let winner;
      if (pAliveCount !== aAliveCount) winner = pAliveCount > aAliveCount ? 'player' : 'ai';
      else winner = pHP >= aHP ? 'player' : 'ai';
      battle.finished = true;
      battle.winner = winner;
      battle.log.push(`⏱️ Time's up! ${winner === 'player' ? 'You win by survival!' : 'Foe wins by survival!'}`);
      await finishBattle(battle, req.user.id, winner === 'player');
      activeBattles.delete(req.user.id);
      return res.json(battleView(battle));
    }

    if (action === 'forfeit') {
      battle.finished = true;
      battle.winner   = 'ai';
      battle.log.push('You forfeited the battle.');
      await finishBattle(battle, req.user.id, false);
      activeBattles.delete(req.user.id);
      return res.json(battleView(battle));
    }

    if (action === 'attach') {
      // Free action — attach 1 energy orb to any card (active or bench)
      if (battle.playerEnergyAttached)
        return res.status(400).json({ error: 'Already attached energy this turn.' });
      const target = req.body.target; // 'active' | bench index number
      let targetCard;
      if (target === 'active') {
        targetCard = battle.playerCards[battle.playerActive];
      } else {
        const idx = parseInt(target);
        if (isNaN(idx) || idx < 0 || idx >= battle.playerCards.length)
          return res.status(400).json({ error: 'Invalid target' });
        if (battle.playerCards[idx].current_hp <= 0)
          return res.status(400).json({ error: 'Cannot attach to a fainted card' });
        targetCard = battle.playerCards[idx];
      }
      targetCard.orbs = (targetCard.orbs || 0) + 1;
      battle.playerEnergyAttached = true;
      battle.log.push(`You attached a ${targetCard.type} energy to ${targetCard.name}! (${targetCard.orbs} orb${targetCard.orbs !== 1 ? 's' : ''})`);
      await updateQuestProgress(req.user.id, 'attach_energy');
      return res.json(battleView(battle));
    }

    if (action === 'switch') {
      const idx = parseInt(switchTo);
      if (isNaN(idx) || idx < 0 || idx >= battle.playerCards.length)
        return res.status(400).json({ error: 'Invalid switch target' });
      if (idx === battle.playerActive)
        return res.status(400).json({ error: 'That creature is already active' });
      if (battle.playerCards[idx].current_hp <= 0)
        return res.status(400).json({ error: 'That creature is fainted' });
      const activeCard = battle.playerCards[battle.playerActive];
      const switchCost = activeCard.retreat_cost || 1;
      if ((activeCard.orbs || 0) < switchCost)
        return res.status(400).json({ error: `Retreating ${activeCard.name} costs ${switchCost} orb${switchCost > 1 ? 's' : ''}. It has ${activeCard.orbs || 0}.` });
      activeCard.orbs -= switchCost;
      battle.playerCombo = 0;
      battle.log.push(`You switched to ${battle.playerCards[idx].name}! (-${switchCost} orb${switchCost > 1 ? 's' : ''} from ${activeCard.name})`);
      battle.playerActive = idx;
      battle.playerTurn   = false;
      runAiTurn(battle);
      advanceFainted(battle);
      if (!checkWin(battle)) battle.playerTurn = true;
      if (battle.finished) {
        await finishBattle(battle, req.user.id, battle.winner === 'player');
        activeBattles.delete(req.user.id);
      }
      return res.json(battleView(battle));
    }

    if (action === 'guard') {
      battle.playerGuarded = true;
      battle.playerCombo = 0;
      battle.log.push(`🛡️ You brace for impact — incoming damage halved this turn!`);
      battle.playerTurn = false;
      runAiTurn(battle);
      advanceFainted(battle);
      if (!checkWin(battle)) battle.playerTurn = true;
      if (battle.finished) {
        await finishBattle(battle, req.user.id, battle.winner === 'player');
        activeBattles.delete(req.user.id);
      }
      return res.json(battleView(battle));
    }

    if (action === 'boost') {
      const pa2 = battle.playerCards[battle.playerActive];
      const boostCost = 1;
      if ((pa2.orbs || 0) < boostCost)
        return res.status(400).json({ error: `Boost costs ${boostCost} orb. ${pa2.name} only has ${pa2.orbs || 0}.` });
      pa2.orbs -= boostCost;
      battle.playerBoosted = true;
      battle.playerCombo = 0;
      battle.log.push(`⚡ ${pa2.name} charges up — next attack deals +30% damage!`);
      battle.playerTurn = false;
      runAiTurn(battle);
      advanceFainted(battle);
      if (!checkWin(battle)) battle.playerTurn = true;
      if (battle.finished) {
        await finishBattle(battle, req.user.id, battle.winner === 'player');
        activeBattles.delete(req.user.id);
      }
      return res.json(battleView(battle));
    }

    if (action === 'heal') {
      const pa3 = battle.playerCards[battle.playerActive];
      const healCost = 2;
      const healMax = battle.playerHealMax || 2;
      if ((battle.playerHealUses || 0) >= healMax)
        return res.status(400).json({ error: `Heal used ${healMax} times already — limit reached.` });
      if ((pa3.orbs || 0) < healCost)
        return res.status(400).json({ error: `Heal costs ${healCost} orbs. ${pa3.name} only has ${pa3.orbs || 0}.` });
      pa3.orbs -= healCost;
      const healAmt = Math.floor(pa3.hp * 0.25);
      pa3.current_hp = Math.min(pa3.hp, pa3.current_hp + healAmt);
      battle.playerHealUses = (battle.playerHealUses || 0) + 1;
      battle.playerCombo = 0;
      battle.log.push(`💚 ${pa3.name} recovered ${healAmt} HP! (${battle.playerHealUses}/${healMax} heals used)`);
      battle.playerTurn = false;
      runAiTurn(battle);
      advanceFainted(battle);
      if (!checkWin(battle)) battle.playerTurn = true;
      if (battle.finished) {
        await finishBattle(battle, req.user.id, battle.winner === 'player');
        activeBattles.delete(req.user.id);
      }
      return res.json(battleView(battle));
    }

    // basic / ability — process player status first
    const pa = battle.playerCards[battle.playerActive];
    processStatusDamage(pa, battle, true);
    if (pa.current_hp <= 0) {
      advanceFainted(battle);
      if (checkWin(battle)) {
        await finishBattle(battle, req.user.id, false);
        activeBattles.delete(req.user.id);
        return res.json(battleView(battle));
      }
      battle.playerTurn = false;
      runAiTurn(battle);
      advanceFainted(battle);
      if (!checkWin(battle)) battle.playerTurn = true;
      if (battle.finished) {
        await finishBattle(battle, req.user.id, battle.winner === 'player');
        activeBattles.delete(req.user.id);
      }
      return res.json(battleView(battle));
    }

    const blocked = checkPlayerStatusBlock(battle);
    if (blocked) {
      battle.playerTurn = false;
      runAiTurn(battle);
      advanceFainted(battle);
      if (!checkWin(battle)) battle.playerTurn = true;
      if (battle.finished) {
        await finishBattle(battle, req.user.id, battle.winner === 'player');
        activeBattles.delete(req.user.id);
      }
      return res.json(battleView(battle));
    }

    const aa = battle.aiCards[battle.aiActive];

    if (action === 'basic' || action === 'attack') {
      battle.playerCombo = (battle.playerCombo || 0) + 1;
      const bonus = getBenchBonus(battle.playerCards, battle.playerActive);
      const speedBonus = pa.spd >= aa.spd * 1.3 ? 1.15 : 1;
      const boostMult = battle.playerBoosted ? 1.3 : 1;
      battle.playerBoosted = false;
      const coachAtkMult = (battle.playerCoach?.buff_type === 'atk_bonus') ? (1 + parseFloat(battle.playerCoach.buff_value)) : 1;
      const coachCritBonus = (battle.playerCoach?.buff_type === 'crit_bonus') ? parseFloat(battle.playerCoach.buff_value) : 0;
      const { dmg: rawDmg, crit } = calcBasicDamage(pa, aa, coachCritBonus);
      let dmg = Math.floor(rawDmg * bonus * speedBonus * boostMult * coachAtkMult);

      // Void trait: store damage instead of applying
      if (pa.trait?.special_type === 'void') {
        if (!battle.playerVoidMode) {
          battle.playerVoidMode = true;
          battle.playerVoidTurns = 4;
          battle.playerVoidStored = dmg;
          battle.log.push(`🌑 ${pa.name} enters VOID MODE — storing damage for 4 turns!`);
          // Drain bench orbs
          battle.playerCards.forEach((c, i) => { if (i !== battle.playerActive && c.current_hp > 0) c.orbs = Math.max(0, (c.orbs||0) - 1); });
        } else {
          battle.playerVoidStored += dmg;
          battle.playerVoidTurns--;
          battle.log.push(`🌑 Void absorbs ${dmg} damage (stored: ${battle.playerVoidStored}, ${battle.playerVoidTurns} turns left).`);
          battle.playerCards.forEach((c, i) => { if (i !== battle.playerActive && c.current_hp > 0) c.orbs = Math.max(0, (c.orbs||0) - 1); });
          if (battle.playerVoidTurns <= 0) {
            const release = battle.playerVoidStored + 50;
            aa.current_hp = Math.max(0, aa.current_hp - release);
            battle.log.push(`💥 VOID RELEASE! ${pa.name} unleashes ${release} damage! (+50 bonus)`);
            battle.playerVoidMode = false; battle.playerVoidStored = 0; battle.playerVoidTurns = 0;
          }
        }
        // No regular damage applied
        advanceFainted(battle);
        if (checkWin(battle)) { await finishBattle(battle, req.user.id, true); activeBattles.delete(req.user.id); return res.json(battleView(battle)); }
        battle.playerTurn = false; runAiTurn(battle); advanceFainted(battle);
        if (!checkWin(battle)) battle.playerTurn = true;
        if (battle.finished) { await finishBattle(battle, req.user.id, battle.winner === 'player'); activeBattles.delete(req.user.id); }
        return res.json(battleView(battle));
      }

      aa.current_hp = Math.max(0, aa.current_hp - dmg);
      const parts = [`You strike ${aa.name} for ${dmg} damage.`];
      if (crit) parts.push('Critical hit!');
      if (boostMult > 1) parts.push('⚡ Boosted!');
      if (bonus > 1) parts.push('Formation bonus!');
      if (speedBonus > 1) parts.push('Speed advantage!');
      if (coachAtkMult > 1) parts.push(`${battle.playerCoach.name} inspired you!`);
      battle.log.push(parts.join(' '));
      advanceFainted(battle);
      if (checkWin(battle)) {
        await finishBattle(battle, req.user.id, true);
        activeBattles.delete(req.user.id);
        return res.json(battleView(battle));
      }
      battle.playerTurn = false;
      runAiTurn(battle);
      advanceFainted(battle);
      if (!checkWin(battle)) battle.playerTurn = true;
      if (battle.finished) {
        await finishBattle(battle, req.user.id, battle.winner === 'player');
        activeBattles.delete(req.user.id);
      }
      return res.json(battleView(battle));
    }

    if (action === 'ability') {
      const cost = orbCost(pa);
      if ((pa.orbs || 0) < cost)
        return res.status(400).json({ error: `${pa.name} needs ${cost} orbs. It has ${pa.orbs || 0}.` });
      pa.orbs -= cost;
      await updateQuestProgress(req.user.id, 'use_ability');
      const combo = battle.playerCombo || 0;
      const comboMult = combo >= 3 ? 1.5 : 1;
      battle.playerCombo = 0;
      const boostMult2 = battle.playerBoosted ? 1.3 : 1;
      battle.playerBoosted = false;
      const bonus = getBenchBonus(battle.playerCards, battle.playerActive);
      const coachAtkMult2 = (battle.playerCoach?.buff_type === 'atk_bonus') ? (1 + parseFloat(battle.playerCoach.buff_value)) : 1;
      let dmg = calcDamage(pa, aa);
      dmg = Math.floor(dmg * comboMult * bonus * boostMult2 * coachAtkMult2);

      // Void trait: store damage instead of applying
      if (pa.trait?.special_type === 'void') {
        pa.orbs += cost; // refund — void stores the damage not the orbs
        if (!battle.playerVoidMode) {
          battle.playerVoidMode = true; battle.playerVoidTurns = 4; battle.playerVoidStored = dmg;
          battle.log.push(`🌑 ${pa.name} enters VOID MODE — storing ability damage for 4 turns!`);
          battle.playerCards.forEach((c, i) => { if (i !== battle.playerActive && c.current_hp > 0) c.orbs = Math.max(0, (c.orbs||0) - 1); });
        } else {
          battle.playerVoidStored += dmg; battle.playerVoidTurns--;
          battle.log.push(`🌑 Void absorbs ${dmg} (stored: ${battle.playerVoidStored}, ${battle.playerVoidTurns} turns left).`);
          battle.playerCards.forEach((c, i) => { if (i !== battle.playerActive && c.current_hp > 0) c.orbs = Math.max(0, (c.orbs||0) - 1); });
          if (battle.playerVoidTurns <= 0) {
            const release = battle.playerVoidStored + 50;
            aa.current_hp = Math.max(0, aa.current_hp - release);
            battle.log.push(`💥 VOID RELEASE! ${pa.name} unleashes ${release} damage! (+50 bonus)`);
            battle.playerVoidMode = false; battle.playerVoidStored = 0; battle.playerVoidTurns = 0;
          }
        }
        advanceFainted(battle);
        if (checkWin(battle)) { await finishBattle(battle, req.user.id, true); activeBattles.delete(req.user.id); return res.json(battleView(battle)); }
        battle.playerTurn = false; runAiTurn(battle); advanceFainted(battle);
        if (!checkWin(battle)) battle.playerTurn = true;
        if (battle.finished) { await finishBattle(battle, req.user.id, battle.winner === 'player'); activeBattles.delete(req.user.id); }
        return res.json(battleView(battle));
      }

      const eff = typeEffectText(pa, aa);
      aa.current_hp = Math.max(0, aa.current_hp - dmg);
      const parts = [`You unleashed ${pa.ability_name} on ${aa.name}!`];
      if (eff) parts.push(eff.trim());
      if (comboMult > 1) parts.push('🔥 COMBO x1.5!');
      if (boostMult2 > 1) parts.push('⚡ Boosted!');
      if (bonus > 1) parts.push('Formation bonus!');
      if (coachAtkMult2 > 1) parts.push(`${battle.playerCoach.name} powered you up!`);
      parts.push(`Dealt ${dmg} damage.`);
      battle.log.push(parts.join(' '));
      applyStatus(pa, aa, battle);
      advanceFainted(battle);
      if (checkWin(battle)) {
        await finishBattle(battle, req.user.id, true);
        activeBattles.delete(req.user.id);
        return res.json(battleView(battle));
      }
      battle.playerTurn = false;
      runAiTurn(battle);
      advanceFainted(battle);
      if (!checkWin(battle)) battle.playerTurn = true;
      if (battle.finished) {
        await finishBattle(battle, req.user.id, battle.winner === 'player');
        activeBattles.delete(req.user.id);
      }
      return res.json(battleView(battle));
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function battleView(b) {
  return {
    id:           b.id,
    playerCards:  b.playerCards,
    aiCards:      b.aiCards,
    playerActive: b.playerActive,
    aiActive:     b.aiActive,
    playerTurn:   b.playerTurn,
    playerCoach:  b.playerCoach  || null,
    playerVoidMode:   b.playerVoidMode   || false,
    playerVoidTurns:  b.playerVoidTurns  || 0,
    playerVoidStored: b.playerVoidStored || 0,
    log:          b.log,
    finished:     b.finished,
    winner:       b.winner,
    ratingResult: b.ratingResult || null,
    playerCombo:          b.playerCombo          || 0,
    playerGuarded:        b.playerGuarded        || false,
    playerBoosted:        b.playerBoosted        || false,
    playerEnergyAttached: b.playerEnergyAttached || false,
    playerHealUses:       b.playerHealUses       || 0,
    playerHealMax:        b.playerHealMax        || 2,
    bossEnraged:          b.bossEnraged          || false,
    bossSurgeActive:      b.bossSurgeActive      || false,
    startedAt:    b.startedAt || b.createdAt,
    timeLimit:    b.timeLimit || 120000,
  };
}

// ─── QUEST PROGRESS HELPER ───────────────────────────────────────
async function updateQuestProgress(userId, questType, increment = 1) {
  try {
    const now = new Date();
    const res = await query(
      `SELECT uq.id, uq.progress, uq.completed, qd.target
       FROM user_quests uq
       JOIN quest_definitions qd ON qd.id = uq.quest_def_id
       WHERE uq.user_id=$1 AND qd.quest_type=$2 AND uq.completed=false AND uq.expires_at > $3`,
      [userId, questType, now]
    );
    for (const row of res.rows) {
      const newProgress = Math.min(row.progress + increment, row.target);
      const completed = newProgress >= row.target;
      await query(
        'UPDATE user_quests SET progress=$1, completed=$2 WHERE id=$3',
        [newProgress, completed, row.id]
      );
    }
  } catch (e) { console.error('updateQuestProgress error:', e.message); }
}

async function finishBattle(battle, userId, won) {
  try {
    const p1hp = battle.playerCards.reduce((s,c) => s + c.current_hp, 0);
    const p2hp = battle.aiCards.reduce((s,c)    => s + c.current_hp, 0);
    await query(
      'INSERT INTO matches (player1_id, winner_id, p1_hp_left, p2_hp_left, match_log) VALUES ($1,$2,$3,$4,$5)',
      [userId, won ? userId : null, p1hp, p2hp, JSON.stringify(battle.log)]
    );
    // Conquest mode: award coins, record progress, skip ELO
    if (battle.isConquest) {
      if (won) {
        const reward = battle.conquestReward || 0;
        const chId = battle.conquestChapterId;
        const stId = battle.conquestStageId;
        battle.ratingResult = { conquestWin: true, coinsEarned: reward, bossCardUnlocked: null, pieceDropped: stId, traitDropped: null };
        if (!battle.isReplay) {
          const coinsMult = (battle.playerCoach?.buff_type === 'coins_bonus') ? parseFloat(battle.playerCoach.buff_value) : 1;
          const finalReward = Math.round(reward * coinsMult);
          await query('UPDATE users SET coins = coins + $1 WHERE id=$2', [finalReward, userId]);
          battle.ratingResult.coinsEarned = finalReward;
          await query(
            'INSERT INTO conquest_progress (user_id, chapter_id, stage_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [userId, chId, stId]
          );
          // Trait drop: boss 20%, normal stage 10%
          try {
            const dropChance = battle.isBoss ? 0.20 : 0.10;
            if (Math.random() < dropChance) {
              // Roll rarity: Common 70%, Rare 20%, Legendary 9%, Secret 1%
              const r = Math.random();
              let traitRarity;
              if (r < 0.70) traitRarity = 'Common';
              else if (r < 0.90) traitRarity = 'Rare';
              else if (r < 0.99) traitRarity = 'Legendary';
              else traitRarity = 'Secret';
              const traitDrop = await query('SELECT id, name FROM traits WHERE rarity=$1 ORDER BY RANDOM() LIMIT 1', [traitRarity]);
              if (traitDrop.rows.length) {
                const t = traitDrop.rows[0];
                await query('INSERT INTO user_traits (user_id, trait_id) VALUES ($1,$2)', [userId, t.id]);
                battle.ratingResult.traitDropped = { name: t.name, rarity: traitRarity };
              }
            }
          } catch (traitErr) { console.error('Trait drop error:', traitErr.message); }
        }
        // Piece system in its own try/catch so failures don't break the win
        if (!battle.isReplay) try {
          await query(
            'INSERT INTO conquest_pieces (user_id, chapter_id, piece_number) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [userId, chId, stId]
          );
          // Boss stage: check if all 4 pieces collected → unlock boss card
          if (battle.isBoss) {
            const piecesRes = await query(
              'SELECT piece_number FROM conquest_pieces WHERE user_id=$1 AND chapter_id=$2',
              [userId, chId]
            );
            const pieces = piecesRes.rows.map(r => r.piece_number);
            if ([1,2,3,4].every(n => pieces.includes(n))) {
              const key = `${chId}_4`;
              const bc = BOSS_CARDS[key];
              if (bc) {
                await query(`
                  INSERT INTO cards (id, name, type, class, hp, atk, def, spd, ability_name, ability_desc, ability_power, rarity, weakness, resistance, retreat_cost, card_number, is_numbered, set_name)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                  ON CONFLICT (id) DO NOTHING
                `, [bc.id, bc.name, bc.type, bc.class, bc.hp, bc.atk, bc.def, bc.spd,
                    bc.ability_name, bc.ability_desc, bc.ability_power, bc.rarity,
                    bc.weakness, bc.resistance, bc.retreat_cost, bc.card_number,
                    bc.is_numbered, bc.set_name]);
                await query(
                  'INSERT INTO user_cards (user_id, card_id) VALUES ($1,$2) ON CONFLICT (user_id, card_id) DO NOTHING',
                  [userId, bc.id]
                );
                battle.ratingResult.bossCardUnlocked = bc.name;
              }
            }
          }
        } catch (pieceErr) {
          console.error('Piece system error (win still counted):', pieceErr.message);
        }
      } else {
        battle.ratingResult = { conquestWin: false, coinsEarned: 0 };
      }
      // Quest progress for conquest
      await updateQuestProgress(userId, 'play_battle');
      if (won) {
        await updateQuestProgress(userId, 'win_battle');
        await updateQuestProgress(userId, 'win_conquest');
      }
      return;
    }
    // Regular AI battle: coins only, NO ELO (ELO is ranked PvP only)
    if (won) {
      const coinsMult = (battle.playerCoach?.buff_type === 'coins_bonus') ? parseFloat(battle.playerCoach.buff_value) : 1;
      const earned = Math.round(30 * coinsMult);
      await query('UPDATE users SET coins = coins + $1 WHERE id=$2', [earned, userId]);
      battle.ratingResult = { coinsEarned: earned };
    } else {
      battle.ratingResult = { coinsEarned: 0 };
    }
    // Quest progress for regular battle
    await updateQuestProgress(userId, 'play_battle');
    if (won) await updateQuestProgress(userId, 'win_battle');
  } catch (err) {
    console.error('finishBattle error:', err.message);
  }
}

// ─── CONQUEST ROUTES ─────────────────────────────────────────────
// Chapter type themes for stages [s1, s2, s3, s4] — chapters 1-10 live; 11-100 in conquest-plan.md
const CH_TYPES = {
   1:[['Earth','Nature','Air'],['Earth','Nature','Spirit'],['Earth','Shadow','Nature'],['Earth','Shadow','Nature']],
   2:[['Shadow','Nature','Poison'],['Shadow','Poison','Spirit'],['Shadow','Blood','Nature'],['Shadow','Blood','Void']],
   3:[['Water','Spirit','Air'],['Water','Shadow','Ice'],['Water','Dragon','Shadow'],['Water','Dragon','Void']],
   4:[['Fire','Shadow','Chaos'],['Fire','Shadow','Blood'],['Fire','Chaos','Dragon'],['Fire','Dragon','Chaos']],
   5:[['Ice','Spirit','Air'],['Ice','Shadow','Crystal'],['Ice','Light','Void'],['Ice','Light','Crystal']],
   6:[['Cosmic','Air','Light'],['Cosmic','Chaos','Air'],['Cosmic','Void','Light'],['Cosmic','Light','Void']],
   7:[['Void','Shadow','Chaos'],['Void','Chaos','Blood'],['Void','Shadow','Cosmic'],['Void','Cosmic','Shadow']],
   8:[['Shadow','Spirit','Void'],['Void','Blood','Chaos'],['Void','Chaos','Blood','Shadow'],['Void','Chaos','Blood','Shadow']],
   9:[['Spirit','Air','Shadow'],['Spirit','Psychic','Shadow'],['Spirit','Shadow','Void'],['Spirit','Void','Shadow']],
  10:[['Shadow','Void','Chaos'],['Shadow','Chaos','Light'],['Shadow','Void','Light'],['Shadow','Void','Chaos']],
};
// Hardcoded difficulties for ch 1-8 (balanced by hand)
const STAGE_DIFF_FIXED = {
  '1_1':0.55,'1_2':0.70,'1_3':0.85,'1_4':1.00,
  '2_1':1.00,'2_2':1.15,'2_3':1.30,'2_4':1.45,
  '3_1':1.05,'3_2':1.25,'3_3':1.45,'3_4':1.60,
  '4_1':1.20,'4_2':1.40,'4_3':1.60,'4_4':1.80,
  '5_1':1.30,'5_2':1.55,'5_3':1.75,'5_4':2.00,
  '6_1':1.50,'6_2':1.75,'6_3':2.00,'6_4':2.20,
  '7_1':1.80,'7_2':2.05,'7_3':2.30,'7_4':2.50,
  '8_1':2.20,'8_2':2.50,'8_3':2.80,'8_4':3.20,
  '9_1':2.60,'9_2':2.90,'9_3':3.20,'9_4':3.60,
  '10_1':3.00,'10_2':3.35,'10_3':3.70,'10_4':4.20,
};
const STAGE_REWARD_FIXED = {
  '1_1':40,'1_2':60,'1_3':80,'1_4':120,
  '2_1':100,'2_2':120,'2_3':150,'2_4':200,
  '3_1':110,'3_2':140,'3_3':170,'3_4':230,
  '4_1':130,'4_2':160,'4_3':190,'4_4':260,
  '5_1':150,'5_2':180,'5_3':210,'5_4':300,
  '6_1':170,'6_2':200,'6_3':240,'6_4':340,
  '7_1':200,'7_2':240,'7_3':280,'7_4':400,
  '8_1':260,'8_2':300,'8_3':360,'8_4':600,
  '9_1':300,'9_2':360,'9_3':420,'9_4':800,
  '10_1':340,'10_2':400,'10_3':480,'10_4':1000,
};
// Build CONQUEST_STAGES for chapters 1-10 (chapters 11-100 in conquest-plan.md)
const CONQUEST_STAGES = {};
for (let c = 1; c <= 10; c++) {
  for (let s = 1; s <= 4; s++) {
    const key = `${c}_${s}`;
    const types = CH_TYPES[c][s - 1];
    const difficulty = STAGE_DIFF_FIXED[key];
    const reward = STAGE_REWARD_FIXED[key];
    CONQUEST_STAGES[key] = { types, difficulty, reward, isBoss: s === 4 };
  }
}

const BOSS_CARDS = {
  '1_4': { id:99001, name:'Elder Torin, Corrupted', type:'Earth', class:'Titan', hp:480, atk:190, def:150, spd:70, ability_name:'Root Prison', ability_desc:'Corrupted earth vines constrict and drain life from the enemy.', ability_power:170, rarity:'Mythic', weakness:'Fire', resistance:'Water', retreat_cost:3, card_number:'BOSS-001', is_numbered:true, set_name:'Conquest' },
  '2_4': { id:99002, name:'Vethara, The Hollowed', type:'Shadow', class:'Titan', hp:560, atk:210, def:170, spd:85, ability_name:'Void Bramble', ability_desc:'Ancient corrupted bark tears reality, ignoring all defenses.', ability_power:195, rarity:'Mythic', weakness:'Light', resistance:'Nature', retreat_cost:3, card_number:'BOSS-002', is_numbered:true, set_name:'Conquest' },
  '3_4': { id:99003, name:'Tide Drake Kaluun', type:'Water', class:'Dragon', hp:620, atk:230, def:160, spd:110, ability_name:'Black Tide', ability_desc:'A torrent of Void-corrupted water crashes over all enemies at once.', ability_power:210, rarity:'Mythic', weakness:'Thunder', resistance:'Fire', retreat_cost:3, card_number:'BOSS-003', is_numbered:true, set_name:'Conquest' },
  '4_4': { id:99004, name:'Grand Pyromancer Valdris', type:'Fire', class:'Titan', hp:650, atk:260, def:140, spd:100, ability_name:'Void Pyre', ability_desc:'Black flame that does not warm — it only consumes. Deals devastating fire damage.', ability_power:230, rarity:'Mythic', weakness:'Water', resistance:'Ice', retreat_cost:3, card_number:'BOSS-004', is_numbered:true, set_name:'Conquest' },
  '5_4': { id:99005, name:'Throne Queen Seraphine', type:'Ice', class:'Titan', hp:700, atk:240, def:210, spd:90, ability_name:'Absolute Zero', ability_desc:'Flash-freezes the enemy to near absolute zero. Unbreakable cold.', ability_power:220, rarity:'Mythic', weakness:'Fire', resistance:'Water', retreat_cost:3, card_number:'BOSS-005', is_numbered:true, set_name:'Conquest' },
  '6_4': { id:99006, name:'Celestial Warden Exael', type:'Cosmic', class:'Angel', hp:740, atk:270, def:200, spd:130, ability_name:'Rift Collapse', ability_desc:'Collapses the dimensional rift onto the enemy, dealing cosmic damage.', ability_power:245, rarity:'Mythic', weakness:'Void', resistance:'Shadow', retreat_cost:3, card_number:'BOSS-006', is_numbered:true, set_name:'Conquest' },
  '7_4': { id:99007, name:'Void Architect Nulveth', type:'Void', class:'Construct', hp:820, atk:300, def:230, spd:120, ability_name:'Entropy Engine', ability_desc:'Accelerates the decay of all bonds. Pure Void energy annihilates everything.', ability_power:275, rarity:'Mythic', weakness:'Light', resistance:'Cosmic', retreat_cost:3, card_number:'BOSS-007', is_numbered:true, set_name:'Conquest' },
  '8_4': { id:99008, name:'The Unbound', type:'Void', class:'Titan', hp:1000, atk:340, def:260, spd:140, ability_name:'Forgotten Bond', ability_desc:'Strikes with the grief of every abandoned creature. Deals damage equal to every bond ever broken.', ability_power:320, rarity:'Mythic', weakness:'Light', resistance:'Void', retreat_cost:3, card_number:'BOSS-008', is_numbered:true, set_name:'Conquest' },
  '9_4': { id:99009, name:'Phantasm Revael', type:'Spirit', class:'Titan', hp:1100, atk:360, def:270, spd:170, ability_name:'Soul Sunder', ability_desc:'Tears the veil between worlds. Spirit damage that bypasses all defenses and haunts the enemy for 3 turns.', ability_power:335, rarity:'Mythic', weakness:'Shadow', resistance:'Void', retreat_cost:3, card_number:'BOSS-009', is_numbered:true, set_name:'Conquest' },
  '10_4': { id:99010, name:'Herald Moraxis', type:'Shadow', class:'Demon', hp:1300, atk:410, def:300, spd:180, ability_name:"Arxion's Decree", ability_desc:"Channels the descending god's divine order — all enemies are crystallized and shattered by absolute darkness.", ability_power:390, rarity:'Mythic', weakness:'Light', resistance:'Chaos', retreat_cost:3, card_number:'BOSS-010', is_numbered:true, set_name:'Conquest' },
};

app.post('/api/conquest/start', auth, checkMaintenance('battle'), async (req, res) => {
  try {
    const { chapterId, stageId, replay = false } = req.body;
    const key = `${chapterId}_${stageId}`;
    const stage = CONQUEST_STAGES[key];
    if (!stage) return res.status(400).json({ error: 'Invalid stage' });
    let playerPool = await getPlayerDeck(req.user.id);
    const typeList = stage.types.map(t => `'${t}'`).join(',');
    let aiRes = await query(`SELECT * FROM cards WHERE type IN (${typeList}) AND (print_limit IS NULL OR print_count < print_limit) ORDER BY RANDOM() LIMIT 5`);
    let aiPool = aiRes.rows;
    if (aiPool.length < 5) {
      const extras = await query('SELECT * FROM cards ORDER BY RANDOM() LIMIT $1', [5 - aiPool.length]);
      aiPool = [...aiPool, ...extras.rows];
    }

    // Load equipped coach and card traits (same as regular battle)
    const coachRes2 = await query(
      'SELECT c.* FROM coaches c JOIN users u ON u.equipped_coach_id = c.id WHERE u.id = $1',
      [req.user.id]
    );
    const coach2 = coachRes2.rows[0] || null;
    const orbStart2 = (coach2?.buff_type === 'orb_start') ? parseInt(coach2.buff_value) : 0;
    const maxHealUses2 = 2 + ((coach2?.buff_type === 'heal_bonus') ? parseInt(coach2.buff_value) : 0);

    const cardIds2 = playerPool.map(c => c.id);
    const traitRes2 = cardIds2.length
      ? await query(
          'SELECT uct.card_id, t.* FROM user_card_traits uct JOIN traits t ON t.id = uct.trait_id WHERE uct.user_id=$1 AND uct.card_id = ANY($2)',
          [req.user.id, cardIds2]
        )
      : { rows: [] };
    const traitMap2 = {};
    for (const r of traitRes2.rows) traitMap2[r.card_id] = r;

    const d = stage.difficulty;
    const toSlot = (cards, scale, applyTraits = false) => cards.map(c => {
      const trait = applyTraits ? (traitMap2[c.id] || null) : null;
      const atkMod = trait && trait.special_type !== 'void' ? parseFloat(trait.atk_mod || 0) : 0;
      const defMod = trait && trait.special_type !== 'void' ? parseFloat(trait.def_mod || 0) : 0;
      return {
        ...c,
        hp:         Math.round(c.hp * scale),
        current_hp: Math.round(c.hp * scale),
        atk:        Math.round(c.atk * scale * (1 + atkMod)),
        def:        Math.round(c.def * scale * (1 + defMod)),
        status:     null,
        orbs:       orbStart2,
        trait: trait ? { id: trait.id, name: trait.name, rarity: trait.rarity, special_type: trait.special_type || null } : null,
      };
    });
    // Boss stages: replace AI lead card with boss card
    const bossCard = BOSS_CARDS[key];
    let finalAiCards = toSlot(aiPool, d, false);
    if (bossCard && stage.isBoss) {
      const bc = { ...bossCard, current_hp: bossCard.hp, isBossCard: true, orbs: 0 };
      finalAiCards = [bc, ...finalAiCards.slice(0, 4)];
    }
    const battle = {
      id:                `conquest_${req.user.id}_${Date.now()}`,
      userId:            req.user.id,
      playerCards:       toSlot(playerPool, 1, true),
      aiCards:           finalAiCards,
      playerActive:      0,
      aiActive:          0,
      playerTurn:        true,
      log:               [stage.isBoss ? '⚔️ BOSS BATTLE! Attach Energy each turn to power up your cards!' : 'Conquest battle! Attach Energy each turn, then strike when ready.'],
      finished:          false,
      winner:            null,
      createdAt:         Date.now(),
      startedAt:         Date.now(),
      timeLimit:         120000,
      isConquest:        true,
      isBoss:            !!stage.isBoss,
      conquestChapterId: chapterId,
      conquestStageId:   stageId,
      conquestReward:    replay ? 0 : stage.reward,
      isReplay:          !!replay,
      playerGuarded:        false,
      playerCombo:          0,
      playerEnergyAttached: false,
      playerHealUses:       0,
      playerHealMax:        maxHealUses2,
      playerBoosted:        false,
      bossEnraged:          false,
      bossSurgeActive:      false,
      playerCoach:          coach2 ? { id: coach2.id, name: coach2.name, portrait: coach2.portrait, buff_type: coach2.buff_type, buff_value: parseFloat(coach2.buff_value), quotes: coach2.quote_lines } : null,
      playerVoidMode:       false,
      playerVoidTurns:      0,
      playerVoidStored:     0,
    };
    activeBattles.set(req.user.id, battle);
    res.json(battleView(battle));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/conquest/progress', auth, async (req, res) => {
  try {
    const [progress, pieces] = await Promise.all([
      query('SELECT chapter_id, stage_id FROM conquest_progress WHERE user_id=$1', [req.user.id]),
      query('SELECT chapter_id, piece_number FROM conquest_pieces WHERE user_id=$1', [req.user.id]),
    ]);
    res.json({ progress: progress.rows, pieces: pieces.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── QUEST & BATTLEPASS ROUTES ───────────────────────────────────

// Assign quests if missing (called on load)
async function ensureQuestsAssigned(userId) {
  const now = new Date();
  const todayEnd = new Date(now); todayEnd.setHours(23,59,59,999);
  const weekEnd  = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));
  weekEnd.setHours(23,59,59,999);

  // Check if user has active daily quests
  const daily = await query(
    `SELECT COUNT(*) FROM user_quests uq
     JOIN quest_definitions qd ON qd.id = uq.quest_def_id
     WHERE uq.user_id=$1 AND qd.category='daily' AND uq.expires_at > $2`,
    [userId, now]
  );
  if (parseInt(daily.rows[0].count) === 0) {
    // Assign 3 random daily quests
    const defs = await query(
      `SELECT id FROM quest_definitions WHERE category='daily' ORDER BY RANDOM() LIMIT 3`
    );
    for (const d of defs.rows) {
      await query(
        `INSERT INTO user_quests (user_id, quest_def_id, expires_at) VALUES ($1,$2,$3)`,
        [userId, d.id, todayEnd]
      );
    }
  }

  // Check weekly quests
  const weekly = await query(
    `SELECT COUNT(*) FROM user_quests uq
     JOIN quest_definitions qd ON qd.id = uq.quest_def_id
     WHERE uq.user_id=$1 AND qd.category='weekly' AND uq.expires_at > $2`,
    [userId, now]
  );
  if (parseInt(weekly.rows[0].count) === 0) {
    const defs = await query(
      `SELECT id FROM quest_definitions WHERE category='weekly' ORDER BY RANDOM() LIMIT 2`
    );
    for (const d of defs.rows) {
      await query(
        `INSERT INTO user_quests (user_id, quest_def_id, expires_at) VALUES ($1,$2,$3)`,
        [userId, d.id, weekEnd]
      );
    }
  }
}

// Ensure battlepass row exists
async function ensureBattlepass(userId) {
  await query(
    `INSERT INTO user_battlepass (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [userId]
  );
}

app.get('/api/quests', auth, async (req, res) => {
  try {
    await ensureQuestsAssigned(req.user.id);
    const quests = await query(
      `SELECT uq.id, uq.progress, uq.completed, uq.claimed, uq.expires_at,
              qd.slug, qd.category, qd.name, qd.description, qd.icon, qd.quest_type, qd.target, qd.xp_reward
       FROM user_quests uq
       JOIN quest_definitions qd ON qd.id = uq.quest_def_id
       WHERE uq.user_id=$1 AND uq.expires_at > NOW()
       ORDER BY qd.category, uq.id`,
      [req.user.id]
    );
    res.json({ quests: quests.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/quests/:id/claim', auth, async (req, res) => {
  try {
    const questId = parseInt(req.params.id);
    const uq = await query(
      `SELECT uq.*, qd.xp_reward FROM user_quests uq
       JOIN quest_definitions qd ON qd.id = uq.quest_def_id
       WHERE uq.id=$1 AND uq.user_id=$2`,
      [questId, req.user.id]
    );
    if (!uq.rows.length) return res.status(404).json({ error: 'Quest not found' });
    const quest = uq.rows[0];
    if (!quest.completed) return res.status(400).json({ error: 'Quest not completed yet' });
    if (quest.claimed)    return res.status(400).json({ error: 'Already claimed' });

    await query('UPDATE user_quests SET claimed=true WHERE id=$1', [questId]);
    await ensureBattlepass(req.user.id);
    // Award XP and level up battlepass
    const bp = await query('SELECT * FROM user_battlepass WHERE user_id=$1', [req.user.id]);
    const current = bp.rows[0];
    const newXp = current.xp + quest.xp_reward;
    // Find new level: highest level where xp_required <= newXp
    const levels = await query('SELECT level, xp_required FROM battlepass_rewards ORDER BY level');
    let newLevel = current.level;
    for (const row of levels.rows) {
      if (newXp >= row.xp_required) newLevel = row.level;
    }
    await query('UPDATE user_battlepass SET xp=$1, level=$2 WHERE user_id=$3', [newXp, newLevel, req.user.id]);
    res.json({ xpGained: quest.xp_reward, totalXp: newXp, level: newLevel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/battlepass', auth, async (req, res) => {
  try {
    await ensureBattlepass(req.user.id);
    const [bp, rewards] = await Promise.all([
      query('SELECT * FROM user_battlepass WHERE user_id=$1', [req.user.id]),
      query('SELECT * FROM battlepass_rewards ORDER BY level'),
    ]);
    res.json({ battlepass: bp.rows[0], rewards: rewards.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/battlepass/claim/:level', auth, async (req, res) => {
  try {
    const level = parseInt(req.params.level);
    await ensureBattlepass(req.user.id);
    const bp = await query('SELECT * FROM user_battlepass WHERE user_id=$1', [req.user.id]);
    const current = bp.rows[0];
    if (level > current.level) return res.status(400).json({ error: 'Level not reached yet' });
    if ((current.claimed_levels || []).includes(level)) return res.status(400).json({ error: 'Already claimed' });

    const reward = await query('SELECT * FROM battlepass_rewards WHERE level=$1', [level]);
    if (!reward.rows.length) return res.status(404).json({ error: 'Reward not found' });
    const r = reward.rows[0];

    // Grant reward
    if (r.reward_type === 'coins') {
      await query('UPDATE users SET coins = coins + $1 WHERE id=$2', [r.reward_value, req.user.id]);
    } else if (r.reward_type === 'pack' || r.reward_type === 'coach_pack') {
      // We just give coins equivalent for packs (200 per standard, 300 rare, 500 epic/legendary, 500 coach)
      const packValues = { pack: 200, coach_pack: 500 };
      const val = (packValues[r.reward_type] || 200) * r.reward_value;
      await query('UPDATE users SET coins = coins + $1 WHERE id=$2', [val, req.user.id]);
    }

    await query(
      'UPDATE user_battlepass SET claimed_levels = array_append(claimed_levels, $1) WHERE user_id=$2',
      [level, req.user.id]
    );

    // Re-fetch updated user coins
    const userRow = await query('SELECT coins FROM users WHERE id=$1', [req.user.id]);
    res.json({ claimed: true, reward: r, newCoins: userRow.rows[0].coins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DECK ROUTES ─────────────────────────────────────────────────
app.get('/api/deck', auth, async (req, res) => {
  try {
    const deckRes = await query('SELECT card_ids FROM decks WHERE user_id=$1', [req.user.id]);
    const cardIds = deckRes.rows[0]?.card_ids || [];
    if (!cardIds.length) return res.json({ cards: [], card_ids: [] });
    const cards = await query(
      'SELECT c.* FROM cards c JOIN user_cards uc ON uc.card_id=c.id WHERE uc.user_id=$1 AND c.id = ANY($2)',
      [req.user.id, cardIds]
    );
    res.json({ cards: cards.rows, card_ids: cardIds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/deck', auth, async (req, res) => {
  try {
    const { card_ids } = req.body;
    if (!Array.isArray(card_ids) || card_ids.length < 1) return res.status(400).json({ error: 'Select 1–5 cards' });
    if (card_ids.length > 5) return res.status(400).json({ error: 'Deck cannot exceed 5 cards' });
    const owned = await query('SELECT card_id FROM user_cards WHERE user_id=$1 AND card_id = ANY($2)', [req.user.id, card_ids]);
    const ownedIds = owned.rows.map(r => r.card_id);
    if (!card_ids.every(id => ownedIds.includes(id))) return res.status(400).json({ error: 'You do not own all selected cards' });
    await query(
      'INSERT INTO decks (user_id,card_ids) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET card_ids=$2',
      [req.user.id, JSON.stringify(card_ids)]
    );
    res.json({ message: 'Deck saved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/deck/auto', auth, async (req, res) => {
  try {
    const { mode, type } = req.body;
    let sql, params;
    if (mode === 'type' && type) {
      sql = 'SELECT c.* FROM cards c JOIN user_cards uc ON uc.card_id=c.id WHERE uc.user_id=$1 AND c.type=$2 ORDER BY (c.atk+c.def+c.hp+c.spd) DESC LIMIT 5';
      params = [req.user.id, type];
    } else {
      sql = 'SELECT c.* FROM cards c JOIN user_cards uc ON uc.card_id=c.id WHERE uc.user_id=$1 ORDER BY (c.atk+c.def+c.hp+c.spd) DESC LIMIT 5';
      params = [req.user.id];
    }
    const cards = await query(sql, params);
    if (!cards.rows.length) return res.status(400).json({ error: 'No cards in collection' + (type ? ' for that type' : '') });
    const cardIds = cards.rows.map(c => c.id);
    await query(
      'INSERT INTO decks (user_id,card_ids) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET card_ids=$2',
      [req.user.id, JSON.stringify(cardIds)]
    );
    res.json({ cards: cards.rows, card_ids: cardIds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PVP ROUTES ──────────────────────────────────────────────────
app.post('/api/pvp/queue', auth, async (req, res) => {
  try {
    // Already in a live battle?
    const existingBid = userToBattle.get(req.user.id);
    if (existingBid) {
      const b = pvpBattles.get(existingBid);
      if (b && !b.finished) return res.json({ status: 'in_battle' });
      userToBattle.delete(req.user.id);
    }
    const { ranked } = req.body;
    const cards = await getPlayerDeck(req.user.id);
    const coachRes = await query('SELECT c.* FROM coaches c JOIN users u ON u.equipped_coach_id = c.id WHERE u.id = $1', [req.user.id]);
    const coach = coachRes.rows[0] || null;
    const orbStart = (coach?.buff_type === 'orb_start') ? parseInt(coach.buff_value) : 0;
    const healMax = 2 + ((coach?.buff_type === 'heal_bonus') ? parseInt(coach.buff_value) : 0);
    const cardIds = cards.map(c => c.id);
    const traitRes = cardIds.length ? await query('SELECT uct.card_id, t.* FROM user_card_traits uct JOIN traits t ON t.id = uct.trait_id WHERE uct.user_id=$1 AND uct.card_id = ANY($2)', [req.user.id, cardIds]) : { rows: [] };
    const traitMap = {};
    for (const r of traitRes.rows) traitMap[r.card_id] = r;
    pvpQueue.set(req.user.id, { userId: req.user.id, username: req.user.username, ranked: !!ranked, cards, coach, orbStart, healMax, traitMap, joinedAt: Date.now() });
    tryMatchPlayers();
    if (userToBattle.has(req.user.id)) return res.json({ status: 'matched' });
    res.json({ status: 'queued' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pvp/queue', auth, (req, res) => {
  pvpQueue.delete(req.user.id);
  res.json({ message: 'Left queue' });
});

app.get('/api/pvp/queue/status', auth, (req, res) => {
  if (userToBattle.has(req.user.id)) {
    const b = pvpBattles.get(userToBattle.get(req.user.id));
    if (b && !b.finished) return res.json({ status: 'matched' });
    userToBattle.delete(req.user.id);
  }
  if (pvpQueue.has(req.user.id)) {
    const e = pvpQueue.get(req.user.id);
    return res.json({ status: 'queued', waitTime: Math.floor((Date.now() - e.joinedAt) / 1000) });
  }
  res.json({ status: 'idle' });
});

app.get('/api/pvp/battle', auth, (req, res) => {
  const bid = userToBattle.get(req.user.id);
  if (!bid) return res.status(404).json({ error: 'No active PvP battle' });
  const battle = pvpBattles.get(bid);
  if (!battle) return res.status(404).json({ error: 'Battle not found' });
  if (!battle.finished && Date.now() - battle.lastAction > 30000) {
    executePvpAutoAttack(battle);
    if (battle.finished) finishPvpBattle(battle).catch(console.error);
  }
  res.json(getPvpStateForUser(battle, req.user.id));
});

app.post('/api/pvp/chat', auth, (req, res) => {
  const bid = userToBattle.get(req.user.id);
  if (!bid) return res.status(404).json({ error: 'No active battle' });
  const battle = pvpBattles.get(bid);
  if (!battle) return res.status(404).json({ error: 'Battle not found' });
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Empty message' });
  const msg = message.trim().slice(0, 120);
  battle.battleChat.push({ userId: req.user.id, username: req.user.username, msg, time: Date.now() });
  if (battle.battleChat.length > 100) battle.battleChat.shift();
  res.json({ ok: true });
});

app.post('/api/pvp/action', auth, async (req, res) => {
  try {
    const bid = userToBattle.get(req.user.id);
    if (!bid) return res.status(404).json({ error: 'No active PvP battle' });
    const battle = pvpBattles.get(bid);
    if (!battle) return res.status(404).json({ error: 'Battle not found' });
    if (battle.finished) return res.status(400).json({ error: 'Battle already finished' });
    const isP1 = battle.player1Id === req.user.id;
    if ((battle.turn === 'player1') !== isP1) return res.status(400).json({ error: 'Not your turn' });

    const { action, switchTo, target } = req.body;
    const myCards    = isP1 ? battle.player1Cards    : battle.player2Cards;
    const theirCards = isP1 ? battle.player2Cards    : battle.player1Cards;
    const myActiveIdx    = isP1 ? battle.player1Active : battle.player2Active;
    const theirActiveIdx = isP1 ? battle.player2Active : battle.player1Active;
    const myUser    = isP1 ? battle.player1Username : battle.player2Username;
    const theirUser = isP1 ? battle.player2Username : battle.player1Username;

    // Per-player state keys
    const myEnergyKey  = isP1 ? 'p1EnergyAttached' : 'p2EnergyAttached';
    const myBoostKey   = isP1 ? 'p1Boosted'        : 'p2Boosted';
    const myGuardKey   = isP1 ? 'p1Guarded'        : 'p2Guarded';
    const myHealUsesKey= isP1 ? 'p1HealUses'       : 'p2HealUses';
    const myHealMaxKey = isP1 ? 'p1HealMax'        : 'p2HealMax';
    const myCoachKey   = isP1 ? 'p1Coach'          : 'p2Coach';
    const theirGuardKey= isP1 ? 'p2Guarded'        : 'p1Guarded';
    const myVoidModeKey   = isP1 ? 'p1VoidMode'    : 'p2VoidMode';
    const myVoidTurnsKey  = isP1 ? 'p1VoidTurns'   : 'p2VoidTurns';
    const myVoidStoredKey = isP1 ? 'p1VoidStored'  : 'p2VoidStored';

    const myCoach = battle[myCoachKey];
    const pa = myCards[myActiveIdx];
    const aa = theirCards[theirActiveIdx];

    // Helper: flip turn and reset new player's energy
    const endTurn = () => {
      battle.turn = battle.turn === 'player1' ? 'player2' : 'player1';
      battle.lastAction = Date.now();
      if (battle.turn === 'player1') battle.p1EnergyAttached = false;
      else battle.p2EnergyAttached = false;
    };

    // ── FORFEIT ──
    if (action === 'forfeit') {
      battle.finished = true;
      battle.winner = isP1 ? 'player2' : 'player1';
      battle.log.push(`${myUser} forfeited.`);
      await finishPvpBattle(battle);
      setTimeout(() => { pvpBattles.delete(bid); userToBattle.delete(battle.player1Id); userToBattle.delete(battle.player2Id); }, 120000);
      return res.json(getPvpStateForUser(battle, req.user.id));
    }

    // ── ATTACH ENERGY (free action, no turn end) ──
    if (action === 'attach') {
      if (battle[myEnergyKey]) return res.status(400).json({ error: 'Already attached energy this turn.' });
      let targetCard;
      if (target === 'active') {
        targetCard = pa;
      } else {
        const idx = parseInt(target);
        if (isNaN(idx) || idx < 0 || idx >= myCards.length || myCards[idx].current_hp <= 0)
          return res.status(400).json({ error: 'Invalid attach target' });
        targetCard = myCards[idx];
      }
      targetCard.orbs = (targetCard.orbs || 0) + 1;
      battle[myEnergyKey] = true;
      battle.log.push(`${myUser} attached energy to ${targetCard.name}! (${targetCard.orbs} orb${targetCard.orbs !== 1 ? 's' : ''})`);
      return res.json(getPvpStateForUser(battle, req.user.id));
    }

    // ── SWITCH ──
    if (action === 'switch') {
      const idx = parseInt(switchTo);
      if (isNaN(idx) || idx < 0 || idx >= myCards.length) return res.status(400).json({ error: 'Invalid switch target' });
      if (myCards[idx].current_hp <= 0) return res.status(400).json({ error: 'That creature is fainted' });
      const switchCost = pa.retreat_cost || 1;
      if ((pa.orbs || 0) < switchCost) return res.status(400).json({ error: `Retreating ${pa.name} costs ${switchCost} orb${switchCost > 1 ? 's' : ''}. It has ${pa.orbs || 0}.` });
      pa.orbs -= switchCost;
      if (isP1) battle.player1Active = idx; else battle.player2Active = idx;
      battle.log.push(`${myUser} switched to ${myCards[idx].name}! (-${switchCost} orb)`);
      endTurn();
      return res.json(getPvpStateForUser(battle, req.user.id));
    }

    // ── GUARD ──
    if (action === 'guard') {
      battle[myGuardKey] = true;
      battle.log.push(`🛡️ ${myUser}'s ${pa.name} braces — incoming damage halved this turn!`);
      endTurn();
      return res.json(getPvpStateForUser(battle, req.user.id));
    }

    // ── BOOST ──
    if (action === 'boost') {
      if ((pa.orbs || 0) < 1) return res.status(400).json({ error: `Boost costs 1 orb. ${pa.name} has ${pa.orbs || 0}.` });
      pa.orbs -= 1;
      battle[myBoostKey] = true;
      battle.log.push(`⚡ ${myUser}'s ${pa.name} charges up — next attack +30% damage!`);
      endTurn();
      return res.json(getPvpStateForUser(battle, req.user.id));
    }

    // ── HEAL ──
    if (action === 'heal') {
      const healMax = battle[myHealMaxKey] || 2;
      if ((battle[myHealUsesKey] || 0) >= healMax) return res.status(400).json({ error: `Heal limit reached (${healMax} uses).` });
      if ((pa.orbs || 0) < 2) return res.status(400).json({ error: `Heal costs 2 orbs. ${pa.name} has ${pa.orbs || 0}.` });
      pa.orbs -= 2;
      const healAmt = Math.floor(pa.hp * 0.25);
      pa.current_hp = Math.min(pa.hp, pa.current_hp + healAmt);
      battle[myHealUsesKey] = (battle[myHealUsesKey] || 0) + 1;
      battle.log.push(`💚 ${myUser}'s ${pa.name} recovered ${healAmt} HP! (${battle[myHealUsesKey]}/${healMax} heals)`);
      endTurn();
      return res.json(getPvpStateForUser(battle, req.user.id));
    }

    // ── BASIC ATTACK ──
    if (action === 'basic') {
      const coachAtkMult = myCoach?.buff_type === 'atk_bonus' ? (1 + parseFloat(myCoach.buff_value)) : 1;
      const boostMult = battle[myBoostKey] ? 1.3 : 1;
      battle[myBoostKey] = false;
      const { dmg: rawDmg, crit } = calcBasicDamage(pa, aa);
      let dmg = Math.floor(rawDmg * boostMult * coachAtkMult);

      // Void trait
      if (pa.trait?.special_type === 'void') {
        if (!battle[myVoidModeKey]) {
          battle[myVoidModeKey] = true; battle[myVoidTurnsKey] = 4; battle[myVoidStoredKey] = dmg;
          battle.log.push(`🌑 ${myUser}'s ${pa.name} enters VOID MODE — storing damage for 4 turns!`);
          myCards.forEach((c, i) => { if (i !== myActiveIdx && c.current_hp > 0) c.orbs = Math.max(0, (c.orbs||0) - 1); });
        } else {
          battle[myVoidStoredKey] += dmg; battle[myVoidTurnsKey]--;
          battle.log.push(`🌑 Void absorbs ${dmg} (stored: ${battle[myVoidStoredKey]}, ${battle[myVoidTurnsKey]} turns left).`);
          myCards.forEach((c, i) => { if (i !== myActiveIdx && c.current_hp > 0) c.orbs = Math.max(0, (c.orbs||0) - 1); });
          if (battle[myVoidTurnsKey] <= 0) {
            const release = battle[myVoidStoredKey] + 50;
            const theirGuarded = battle[theirGuardKey];
            aa.current_hp = Math.max(0, aa.current_hp - (theirGuarded ? Math.floor(release * 0.5) : release));
            battle[theirGuardKey] = false;
            battle.log.push(`💥 VOID RELEASE! ${pa.name} unleashes ${release} damage!`);
            battle[myVoidModeKey] = false; battle[myVoidStoredKey] = 0; battle[myVoidTurnsKey] = 0;
          }
        }
      } else {
        // Apply defender guard and coach def
        const theirCoach = battle[isP1 ? 'p2Coach' : 'p1Coach'];
        const defMult = battle[theirGuardKey] ? 0.5 : 1;
        const coachDefMult = theirCoach?.buff_type === 'def_bonus' ? Math.max(0.1, 1 - parseFloat(theirCoach.buff_value)) : 1;
        battle[theirGuardKey] = false;
        const finalDmg = Math.max(1, Math.floor(dmg * defMult * coachDefMult));
        aa.current_hp = Math.max(0, aa.current_hp - finalDmg);
        battle.log.push(`${myUser}'s ${pa.name} struck${crit ? ' critically' : ''}! Dealt ${finalDmg} to ${theirUser}'s ${aa.name}. (${aa.current_hp}/${aa.hp} HP)`);
      }

      if (aa.current_hp <= 0) {
        const next = theirCards.findIndex((c, i) => i !== theirActiveIdx && c.current_hp > 0);
        if (next !== -1) {
          if (isP1) battle.player2Active = next; else battle.player1Active = next;
          battle.log.push(`${theirUser}'s ${theirCards[next].name} steps forward!`);
        }
      }
      if (!theirCards.some(c => c.current_hp > 0)) {
        battle.finished = true; battle.winner = isP1 ? 'player1' : 'player2';
        battle.log.push(`${myUser} wins! All of ${theirUser}'s creatures were defeated!`);
        await finishPvpBattle(battle);
        setTimeout(() => { pvpBattles.delete(bid); userToBattle.delete(battle.player1Id); userToBattle.delete(battle.player2Id); }, 120000);
        return res.json(getPvpStateForUser(battle, req.user.id));
      }
      endTurn();
      return res.json(getPvpStateForUser(battle, req.user.id));
    }

    // ── ABILITY ATTACK (also handles legacy 'attack') ──
    if (action === 'ability' || action === 'attack') {
      const cost = orbCost(pa);
      if ((pa.orbs || 0) < cost) return res.status(400).json({ error: `${pa.ability_name} costs ${cost} orbs. ${pa.name} has ${pa.orbs || 0}.` });
      pa.orbs -= cost;
      const coachAtkMult = myCoach?.buff_type === 'atk_bonus' ? (1 + parseFloat(myCoach.buff_value)) : 1;
      const boostMult = battle[myBoostKey] ? 1.3 : 1;
      battle[myBoostKey] = false;
      let dmg = calcDamage(pa, aa);
      dmg = Math.floor(dmg * boostMult * coachAtkMult);

      // Void trait
      if (pa.trait?.special_type === 'void') {
        pa.orbs += cost; // refund
        if (!battle[myVoidModeKey]) {
          battle[myVoidModeKey] = true; battle[myVoidTurnsKey] = 4; battle[myVoidStoredKey] = dmg;
          battle.log.push(`🌑 ${myUser}'s ${pa.name} enters VOID MODE via ability!`);
          myCards.forEach((c, i) => { if (i !== myActiveIdx && c.current_hp > 0) c.orbs = Math.max(0, (c.orbs||0) - 1); });
        } else {
          battle[myVoidStoredKey] += dmg; battle[myVoidTurnsKey]--;
          battle.log.push(`🌑 Void absorbs ${dmg} (stored: ${battle[myVoidStoredKey]}, ${battle[myVoidTurnsKey]} turns left).`);
          myCards.forEach((c, i) => { if (i !== myActiveIdx && c.current_hp > 0) c.orbs = Math.max(0, (c.orbs||0) - 1); });
          if (battle[myVoidTurnsKey] <= 0) {
            const release = battle[myVoidStoredKey] + 50;
            const theirGuarded = battle[theirGuardKey];
            aa.current_hp = Math.max(0, aa.current_hp - (theirGuarded ? Math.floor(release * 0.5) : release));
            battle[theirGuardKey] = false;
            battle.log.push(`💥 VOID RELEASE! ${pa.name} unleashes ${release} damage!`);
            battle[myVoidModeKey] = false; battle[myVoidStoredKey] = 0; battle[myVoidTurnsKey] = 0;
          }
        }
      } else {
        const theirCoach = battle[isP1 ? 'p2Coach' : 'p1Coach'];
        const defMult = battle[theirGuardKey] ? 0.5 : 1;
        const coachDefMult = theirCoach?.buff_type === 'def_bonus' ? Math.max(0.1, 1 - parseFloat(theirCoach.buff_value)) : 1;
        battle[theirGuardKey] = false;
        const finalDmg = Math.max(1, Math.floor(dmg * defMult * coachDefMult));
        aa.current_hp = Math.max(0, aa.current_hp - finalDmg);
        battle.log.push(`${myUser}'s ${pa.name} used ${pa.ability_name}! Dealt ${finalDmg} to ${theirUser}'s ${aa.name}. (${aa.current_hp}/${aa.hp} HP)`);
      }

      if (aa.current_hp <= 0) {
        const newTheirActive = isP1 ? battle.player2Active : battle.player1Active;
        const next = theirCards.findIndex((c, i) => i !== newTheirActive && c.current_hp > 0);
        if (next !== -1) {
          if (isP1) battle.player2Active = next; else battle.player1Active = next;
          battle.log.push(`${theirUser}'s ${theirCards[next].name} steps forward!`);
        }
      }
      if (!theirCards.some(c => c.current_hp > 0)) {
        battle.finished = true; battle.winner = isP1 ? 'player1' : 'player2';
        battle.log.push(`${myUser} wins! All of ${theirUser}'s creatures were defeated!`);
        await finishPvpBattle(battle);
        setTimeout(() => { pvpBattles.delete(bid); userToBattle.delete(battle.player1Id); userToBattle.delete(battle.player2Id); }, 120000);
        return res.json(getPvpStateForUser(battle, req.user.id));
      }
      endTurn();
      return res.json(getPvpStateForUser(battle, req.user.id));
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REPORTS ROUTES ──────────────────────────────────────────────
app.post('/api/reports', auth, async (req, res) => {
  try {
    const { reported_username, category, description, evidence_url, priority } = req.body;
    if (!reported_username || !category || !description) return res.status(400).json({ error: 'All fields required' });
    const target = await query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [reported_username]);
    if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
    const pri = ['low','normal','high','urgent'].includes(priority) ? priority : 'normal';
    await query('INSERT INTO reports (reporter_id, reported_user_id, category, description, evidence_url, priority) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, target.rows[0].id, category, description, evidence_url || null, pri]);
    res.json({ message: 'Report submitted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/mine', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT r.*, u.username as reported_username
      FROM reports r JOIN users u ON u.id = r.reported_user_id
      WHERE r.reporter_id = $1 ORDER BY r.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SETTINGS ROUTES ─────────────────────────────────────────────
app.get('/api/settings', auth, async (req, res) => {
  try {
    const s = await query('SELECT * FROM user_settings WHERE user_id = $1', [req.user.id]);
    const u = await query('SELECT username, avatar_color, bio, coins FROM users WHERE id = $1', [req.user.id]);
    res.json({ ...s.rows[0], ...u.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', auth, async (req, res) => {
  try {
    const { theme, show_collection, show_rank, notifications, privacy_level } = req.body;
    await query('UPDATE user_settings SET theme=$1, show_collection=$2, show_rank=$3, notifications=$4, privacy_level=$5 WHERE user_id=$6',
      [theme || 'default', show_collection !== false, show_rank !== false, notifications !== false, privacy_level || 'public', req.user.id]);
    res.json({ message: 'Settings saved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings/avatar', auth, async (req, res) => {
  try {
    const { color } = req.body;
    await query('UPDATE users SET avatar_color=$1 WHERE id=$2', [color, req.user.id]);
    res.json({ message: 'Avatar updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings/avatar-img', auth, async (req, res) => {
  try {
    let { img } = req.body;
    // Allow emoji prefix (e.g. "emoji:🐉") or base64 data URL
    if (!img) return res.status(400).json({ error: 'No image provided' });
    if (img.startsWith('data:') && img.length > 200000) return res.status(400).json({ error: 'Image too large (max ~150KB)' });
    await query('UPDATE users SET avatar_img=$1 WHERE id=$2', [img, req.user.id]);
    res.json({ message: 'Avatar updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings/bio', auth, async (req, res) => {
  try {
    const { bio } = req.body;
    await query('UPDATE users SET bio=$1 WHERE id=$2', [bio?.slice(0, 200), req.user.id]);
    res.json({ message: 'Bio updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings/password', auth, async (req, res) => {
  try {
    const { current, newPassword } = req.body;
    const userRes = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(current, userRes.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be 8+ characters' });
    const hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ message: 'Password changed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ANNOUNCEMENTS (public read) ─────────────────────────────────
app.get('/api/announcements', async (req, res) => {
  try {
    const result = await query('SELECT a.*, u.username FROM announcements a JOIN users u ON u.id = a.author_id ORDER BY a.created_at DESC LIMIT 10');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────
app.get('/api/admin/users', auth, requireRole('mod'), async (req, res) => {
  try {
    const { q } = req.query;
    let sql = `SELECT u.id, u.username, u.role, u.coins, u.banned, u.ban_reason, u.timeout_until, u.created_at,
               COUNT(w.id)::int AS warning_count
               FROM users u LEFT JOIN warnings w ON w.user_id = u.id`;
    const params = [];
    if (q) { sql += ' WHERE u.username ILIKE $1'; params.push('%' + q + '%'); }
    sql += ' GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function guardDeveloper(id, res) {
  const t = await query('SELECT role FROM users WHERE id=$1', [id]);
  if (!t.rows.length) { res.status(404).json({ error: 'User not found' }); return true; }
  if (t.rows[0].role === 'developer') { res.status(403).json({ error: 'Developer accounts cannot be modified' }); return true; }
  return false;
}

app.put('/api/admin/users/:id/ban', auth, requireRole('mod'), async (req, res) => {
  try {
    if (await guardDeveloper(req.params.id, res)) return;
    const { reason } = req.body;
    const target = await query('SELECT role FROM users WHERE id=$1', [req.params.id]);
    if (ROLE_ORDER.indexOf(target.rows[0].role) >= ROLE_ORDER.indexOf(req.user.role))
      return res.status(403).json({ error: 'Cannot ban a user with equal or higher role' });
    await query('UPDATE users SET banned=true, ban_reason=$1 WHERE id=$2', [reason || 'No reason', req.params.id]);
    await logAction(req.user.id, 'BAN', req.params.id, reason);
    res.json({ message: 'User banned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/unban', auth, requireRole('mod'), async (req, res) => {
  try {
    if (await guardDeveloper(req.params.id, res)) return;
    await query('UPDATE users SET banned=false, ban_reason=NULL WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, 'UNBAN', req.params.id, '');
    res.json({ message: 'User unbanned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/role', auth, requireRole('admin'), async (req, res) => {
  try {
    if (await guardDeveloper(req.params.id, res)) return;
    const { role } = req.body;
    const validRoles = { admin: ['mod'], headofstaff: ['mod','admin'], owner: ['mod','admin','headofstaff'], developer: ['mod','admin','headofstaff','owner'] };
    const allowed = validRoles[req.user.role] || [];
    if (!allowed.includes(role)) return res.status(403).json({ error: 'Cannot assign that role' });
    await query('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]);
    await logAction(req.user.id, 'SET_ROLE:' + role, req.params.id, '');
    res.json({ message: 'Role updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/reports', auth, requireRole('mod'), async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT r.*, u1.username as reporter_name, u2.username as reported_name FROM reports r
               JOIN users u1 ON u1.id = r.reporter_id JOIN users u2 ON u2.id = r.reported_user_id`;
    const params = [];
    if (status) { sql += ' WHERE r.status = $1'; params.push(status); }
    sql += ' ORDER BY r.created_at DESC';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/reports/:id', auth, requireRole('mod'), async (req, res) => {
  try {
    const { status, handler_notes } = req.body;
    await query('UPDATE reports SET status=$1, handler_notes=$2, handled_by=$3 WHERE id=$4',
      [status, handler_notes, req.user.id, req.params.id]);
    await logAction(req.user.id, 'REPORT_UPDATE:' + status, null, 'report #' + req.params.id);
    res.json({ message: 'Report updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/reports/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM reports WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, 'DELETE_REPORT', null, 'report #' + req.params.id);
    res.json({ message: 'Report deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/logs', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query(`SELECT al.*, u.username as admin_name FROM admin_logs al
      LEFT JOIN users u ON u.id = al.admin_id ORDER BY al.created_at DESC LIMIT 200`);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', auth, requireRole('admin'), async (req, res) => {
  try {
    const users = await query('SELECT COUNT(*) FROM users');
    const cards = await query('SELECT COUNT(*) FROM cards');
    const matches = await query('SELECT COUNT(*) FROM matches');
    const reports = await query("SELECT COUNT(*) FROM reports WHERE status='open'");
    const topUser = await query('SELECT u.username, rs.rating FROM ranked_stats rs JOIN users u ON u.id=rs.user_id ORDER BY rs.rating DESC LIMIT 1');
    res.json({
      user_count: parseInt(users.rows[0].count),
      card_count: parseInt(cards.rows[0].count),
      match_count: parseInt(matches.rows[0].count),
      open_reports: parseInt(reports.rows[0].count),
      top_player: topUser.rows[0] || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/announcements', auth, requireRole('admin'), async (req, res) => {
  try {
    const { title, body } = req.body;
    await query('INSERT INTO announcements (author_id, title, body) VALUES ($1,$2,$3)', [req.user.id, title, body]);
    await logAction(req.user.id, 'ANNOUNCEMENT', null, title);
    res.json({ message: 'Announcement posted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/coins', auth, requireRole('owner'), async (req, res) => {
  try {
    if (await guardDeveloper(req.params.id, res)) return;
    const { amount } = req.body;
    await query('UPDATE users SET coins = coins + $1 WHERE id=$2', [amount, req.params.id]);
    await logAction(req.user.id, 'COINS:' + amount, req.params.id, '');
    res.json({ message: 'Coins updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id/cards/add', auth, requireRole('owner'), async (req, res) => {
  try {
    const { card_id } = req.body;
    const target = await query('SELECT id FROM users WHERE id=$1', [req.params.id]);
    if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
    await query('INSERT INTO user_cards (user_id, card_id) VALUES ($1,$2) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_cards.quantity + 1', [req.params.id, card_id]);
    await logAction(req.user.id, 'ADD_CARD:' + card_id, req.params.id, '');
    res.json({ message: 'Card added' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', auth, requireRole('owner'), async (req, res) => {
  try {
    if (await guardDeveloper(req.params.id, res)) return;
    const target = await query('SELECT role FROM users WHERE id=$1', [req.params.id]);
    if (ROLE_ORDER.indexOf(target.rows[0].role) >= ROLE_ORDER.indexOf(req.user.role))
      return res.status(403).json({ error: 'Cannot delete user with equal or higher role' });
    await query('DELETE FROM users WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, 'DELETE_USER', req.params.id, '');
    res.json({ message: 'User deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Warnings ──────────────────────────────────────────────────────
app.post('/api/admin/users/:id/warn', auth, requireRole('mod'), async (req, res) => {
  try {
    if (await guardDeveloper(req.params.id, res)) return;
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Reason required' });
    await query('INSERT INTO warnings (user_id, issued_by, reason) VALUES ($1,$2,$3)', [req.params.id, req.user.id, reason]);
    await query(
      "INSERT INTO notifications (user_id, type, message) VALUES ($1,'warning',$2)",
      [req.params.id, `You received a warning: ${reason}`]
    );
    await logAction(req.user.id, 'WARN', req.params.id, reason);
    res.json({ message: 'Warning issued' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users/:id/warnings', auth, requireRole('mod'), async (req, res) => {
  try {
    const result = await query(
      'SELECT w.*, u.username as issued_by_name FROM warnings w LEFT JOIN users u ON u.id = w.issued_by WHERE w.user_id=$1 ORDER BY w.created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/warnings/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await query('DELETE FROM warnings WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, 'DELETE_WARNING', null, 'warning #' + req.params.id);
    res.json({ message: 'Warning removed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Timeouts ───────────────────────────────────────────────────────
const TIMEOUT_DURATIONS = { '1h': 60, '6h': 360, '12h': 720, '24h': 1440, '3d': 4320, '7d': 10080 };
app.put('/api/admin/users/:id/timeout', auth, requireRole('mod'), async (req, res) => {
  try {
    if (await guardDeveloper(req.params.id, res)) return;
    const { duration, reason } = req.body;
    const mins = TIMEOUT_DURATIONS[duration];
    if (!mins) return res.status(400).json({ error: 'Invalid duration. Use: ' + Object.keys(TIMEOUT_DURATIONS).join(', ') });
    const until = new Date(Date.now() + mins * 60000);
    await query('UPDATE users SET timeout_until=$1 WHERE id=$2', [until, req.params.id]);
    await query(
      "INSERT INTO notifications (user_id, type, message) VALUES ($1,'warning',$2)",
      [req.params.id, `You have been timed out for ${duration}${reason ? ': ' + reason : ''}`]
    );
    await logAction(req.user.id, 'TIMEOUT:' + duration, req.params.id, reason || '');
    res.json({ message: `User timed out for ${duration}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id/timeout', auth, requireRole('mod'), async (req, res) => {
  try {
    if (await guardDeveloper(req.params.id, res)) return;
    await query('UPDATE users SET timeout_until=NULL WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, 'REMOVE_TIMEOUT', req.params.id, '');
    res.json({ message: 'Timeout removed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin user detail (includes warning count + timeout) ──────────
app.get('/api/admin/users/:id/detail', auth, requireRole('mod'), async (req, res) => {
  try {
    const u = await query('SELECT id, username, role, coins, banned, ban_reason, timeout_until, created_at FROM users WHERE id=$1', [req.params.id]);
    if (!u.rows.length) return res.status(404).json({ error: 'Not found' });
    const wc = await query('SELECT COUNT(*) FROM warnings WHERE user_id=$1', [req.params.id]);
    res.json({ ...u.rows[0], warning_count: parseInt(wc.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/ranked/reset', auth, requireRole('owner'), async (req, res) => {
  try {
    await query('UPDATE ranked_stats SET season_wins=0, season_losses=0, top500=false');
    await logAction(req.user.id, 'RESET_SEASON', null, '');
    res.json({ message: 'Season reset' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DEVELOPER ROUTES ────────────────────────────────────────────
const devAuth = [auth, requireRole('developer')];

app.get('/api/dev/database/tables', ...devAuth, async (req, res) => {
  try {
    const result = await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    res.json(result.rows.map(r => r.table_name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dev/database/query', ...devAuth, async (req, res) => {
  try {
    const { sql, params } = req.body;
    const result = await query(sql, params || []);
    await logAction(req.user.id, 'RAW_QUERY', null, sql.slice(0, 100));
    res.json({ rows: result.rows, rowCount: result.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/cards/:id', ...devAuth, async (req, res) => {
  try {
    const fields = ['hp','atk','def','spd','ability_name','ability_desc','ability_power','rarity','type'];
    const updates = [];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f}=$${idx++}`); params.push(req.body[f]); }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(req.params.id);
    await query(`UPDATE cards SET ${updates.join(',')} WHERE id=$${idx}`, params);
    await logAction(req.user.id, 'DEV_EDIT_CARD:' + req.params.id, null, JSON.stringify(req.body));
    res.json({ message: 'Card updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dev/cards', ...devAuth, async (req, res) => {
  try {
    const { name, type, cls, hp, atk, def, spd, ability_name, ability_desc, ability_power, retreat_cost, weakness, resistance, rarity, set_name, flavor_text, art_style } = req.body;
    const maxId = await query('SELECT MAX(id) FROM cards');
    const newId = (maxId.rows[0].max || 10500) + 1;
    await query('INSERT INTO cards (id,name,type,class,hp,atk,def,spd,ability_name,ability_desc,ability_power,retreat_cost,weakness,resistance,rarity,set_name,flavor_text,art_style,card_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',
      [newId, name, type, cls, hp, atk, def, spd, ability_name, ability_desc, ability_power, retreat_cost, weakness, resistance, rarity, set_name, flavor_text, art_style, `${String(newId).padStart(5,'0')}/PROMO`]);
    await logAction(req.user.id, 'DEV_CREATE_CARD', null, name);
    res.json({ message: 'Card created', id: newId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/dev/cards/:id', ...devAuth, async (req, res) => {
  try {
    await query('DELETE FROM user_cards WHERE card_id=$1', [req.params.id]);
    await query('DELETE FROM cards WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, 'DEV_DELETE_CARD:' + req.params.id, null, '');
    res.json({ message: 'Card deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dev/performance', ...devAuth, async (req, res) => {
  try {
    const mem = process.memoryUsage();
    res.json({
      uptime: process.uptime(),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      nodeVersion: process.version,
      platform: process.platform
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/users/:id/stats', ...devAuth, async (req, res) => {
  try {
    const { rating, wins, losses, coins } = req.body;
    if (rating !== undefined || wins !== undefined || losses !== undefined) {
      const r = rating !== undefined ? rating : undefined;
      const title = r !== undefined ? rankTitle(r) : undefined;
      const fields = [];
      const params = [];
      let idx = 1;
      if (rating !== undefined) { fields.push(`rating=$${idx++}`); params.push(rating); fields.push(`rank_title=$${idx++}`); params.push(rankTitle(rating)); }
      if (wins !== undefined) { fields.push(`wins=$${idx++}`); params.push(wins); }
      if (losses !== undefined) { fields.push(`losses=$${idx++}`); params.push(losses); }
      params.push(req.params.id);
      if (fields.length) await query(`UPDATE ranked_stats SET ${fields.join(',')} WHERE user_id=$${idx}`, params);
    }
    if (coins !== undefined) await query('UPDATE users SET coins=$1 WHERE id=$2', [coins, req.params.id]);
    await logAction(req.user.id, 'DEV_EDIT_STATS', req.params.id, JSON.stringify(req.body));
    res.json({ message: 'Stats updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/users/:id/custom-title', ...devAuth, async (req, res) => {
  try {
    const { title } = req.body;
    await query('UPDATE users SET custom_title=$1 WHERE id=$2', [title || null, req.params.id]);
    await logAction(req.user.id, 'DEV_CUSTOM_TITLE', req.params.id, title || 'removed');
    res.json({ message: title ? `Title set to "${title}"` : 'Title removed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dev/news', ...devAuth, async (req, res) => {
  try {
    const { title, body } = req.body;
    await query('INSERT INTO news (author_id, title, body) VALUES ($1,$2,$3)', [req.user.id, title, body]);
    res.json({ message: 'News posted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/news/:id', ...devAuth, async (req, res) => {
  try {
    const { title, body } = req.body;
    await query('UPDATE news SET title=$1, body=$2, updated_at=NOW() WHERE id=$3', [title, body, req.params.id]);
    res.json({ message: 'News updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/dev/news/:id', ...devAuth, async (req, res) => {
  try {
    await query('DELETE FROM news WHERE id=$1', [req.params.id]);
    res.json({ message: 'News deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dev/sessions', ...devAuth, async (req, res) => {
  try {
    const result = await query('SELECT s.*, u.username FROM sessions s JOIN users u ON u.id=s.user_id ORDER BY s.last_seen DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/dev/sessions/:id', ...devAuth, async (req, res) => {
  try {
    await query('DELETE FROM sessions WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, 'KILL_SESSION:' + req.params.id, null, '');
    res.json({ message: 'Session terminated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/ranked/leaderboard/:id', ...devAuth, async (req, res) => {
  try {
    const { rating } = req.body;
    await query('UPDATE ranked_stats SET rating=$1, rank_title=$2 WHERE user_id=$3', [rating, rankTitle(rating), req.params.id]);
    await logAction(req.user.id, 'DEV_EDIT_RATING', req.params.id, '' + rating);
    res.json({ message: 'Leaderboard entry updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dev/config', ...devAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM game_config');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/config', ...devAuth, async (req, res) => {
  try {
    const { key, value } = req.body;
    await query('INSERT INTO game_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()', [key, value]);
    res.json({ message: 'Config updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dev/users/:id/logout', ...devAuth, async (req, res) => {
  try {
    await query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
    await logAction(req.user.id, 'FORCE_LOGOUT', req.params.id, '');
    res.json({ message: 'User logged out' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/users/:id/verify', ...devAuth, async (req, res) => {
  try {
    const { verified } = req.body;
    await logAction(req.user.id, verified ? 'VERIFY_USER' : 'FLAG_USER', req.params.id, '');
    res.json({ message: verified ? 'User verified' : 'User flagged' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/maintenance/:feature', ...devAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const feature = req.params.feature;
    if (!['battle','packs','friends','ranked'].includes(feature))
      return res.status(400).json({ error: 'Unknown feature' });
    const val = Boolean(enabled);
    await query('INSERT INTO game_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
      ['maintenance_' + feature, String(val)]);
    maintenanceFlags[feature] = val;
    await logAction(req.user.id, 'DEV_MAINTENANCE', null, `${feature}=${val}`);
    res.json({ ok: true, feature, enabled: val });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DEV PACK MANAGEMENT ─────────────────────────────────────────
app.get('/api/dev/packs', ...devAuth, async (req, res) => {
  try {
    const r = await query('SELECT * FROM custom_packs ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dev/packs', ...devAuth, async (req, res) => {
  try {
    const { pack_id, name, cost, count, description, badge, accent_color, odds, card_filter } = req.body;
    if (!pack_id || !name || !odds) return res.status(400).json({ error: 'pack_id, name, and odds required' });
    if (!/^[a-z0-9_-]+$/.test(pack_id)) return res.status(400).json({ error: 'pack_id must be lowercase alphanumeric/underscore/hyphen' });
    // Validate odds sums to ~100
    const total = Object.values(odds).reduce((s, v) => s + Number(v), 0);
    if (total < 99 || total > 101) return res.status(400).json({ error: `Odds must sum to 100 (got ${total.toFixed(1)})` });
    const r = await query(
      `INSERT INTO custom_packs (pack_id, name, cost, count, description, badge, accent_color, odds, card_filter)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [pack_id, name, cost||200, count||5, description||'', badge||'CUSTOM', accent_color||'#4dd9ff', JSON.stringify(odds), card_filter ? JSON.stringify(card_filter) : null]
    );
    await logAction(req.user.id, 'DEV_CREATE_PACK', null, pack_id);
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Pack ID already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/dev/packs/:packId', ...devAuth, async (req, res) => {
  try {
    const r = await query('DELETE FROM custom_packs WHERE pack_id = $1 RETURNING pack_id', [req.params.packId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pack not found' });
    await logAction(req.user.id, 'DEV_DELETE_PACK', null, req.params.packId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/packs/list', async (req, res) => {
  try {
    const r = await query('SELECT pack_id, name, cost, count, description, badge, accent_color, odds FROM custom_packs WHERE active = true ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get full pack details including resolved card objects
app.get('/api/dev/packs/:packId', ...devAuth, async (req, res) => {
  try {
    const r = await query('SELECT * FROM custom_packs WHERE pack_id = $1', [req.params.packId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pack not found' });
    const pack = r.rows[0];
    const cardIds = pack.card_filter?.card_ids || [];
    let cards = [];
    if (cardIds.length) {
      const placeholders = cardIds.map((_, i) => `$${i+1}`).join(',');
      const cr = await query(`SELECT id, name, type, rarity, hp, atk, def, spd, set_name, ability_name, ability_power FROM cards WHERE id IN (${placeholders})`, cardIds);
      cards = cr.rows;
    }
    res.json({ ...pack, cards });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update card_ids for a pack
app.put('/api/dev/packs/:packId/cards', ...devAuth, async (req, res) => {
  try {
    const { card_ids } = req.body;
    if (!Array.isArray(card_ids)) return res.status(400).json({ error: 'card_ids must be an array' });
    const packRes = await query('SELECT card_filter FROM custom_packs WHERE pack_id = $1', [req.params.packId]);
    if (!packRes.rows.length) return res.status(404).json({ error: 'Pack not found' });
    const existing = packRes.rows[0].card_filter || {};
    const updated = { ...existing, card_ids };
    await query('UPDATE custom_packs SET card_filter = $1 WHERE pack_id = $2', [JSON.stringify(updated), req.params.packId]);
    await logAction(req.user.id, 'DEV_UPDATE_PACK_CARDS', null, `${req.params.packId}: ${card_ids.length} cards`);
    res.json({ ok: true, card_ids });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a custom card for a specific pack (auto-adds to pack's card_ids)
app.post('/api/dev/packs/:packId/card', ...devAuth, async (req, res) => {
  try {
    const packRes = await query('SELECT * FROM custom_packs WHERE pack_id = $1', [req.params.packId]);
    if (!packRes.rows.length) return res.status(404).json({ error: 'Pack not found' });
    const pack = packRes.rows[0];

    const { name, type, cls, hp, atk, def, spd, ability_name, ability_desc, ability_power,
            rarity, retreat_cost, flavor_text, art_style, is_numbered, print_limit } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const W = WEAKNESS_MAP[type] || null;
    const R = RESISTANCE_MAP[type] || null;
    const idRes = await query('SELECT COALESCE(MAX(id),90000) + 1 AS next_id FROM cards WHERE id BETWEEN 90001 AND 95000');
    const newId = idRes.rows[0].next_id;

    await query(`INSERT INTO cards (id, name, type, class, hp, atk, def, spd, ability_name, ability_desc, ability_power,
      rarity, retreat_cost, weakness, resistance, set_name, art_style, flavor_text, is_numbered, print_limit, card_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [newId, name, type || 'Fire', cls || 'Titan', hp || 180, atk || 100, def || 80, spd || 80,
       ability_name || 'Custom Strike', ability_desc || '', ability_power || 120,
       rarity || 'Rare', retreat_cost || 2, W, R,
       `Pack: ${pack.name}`, art_style || 'ink', flavor_text || '',
       is_numbered || false, print_limit || null,
       `${req.params.packId.toUpperCase()}-${newId}`]);

    // Add card to pack's card_ids
    const existing = pack.card_filter || {};
    const card_ids = [...(existing.card_ids || []), newId];
    await query('UPDATE custom_packs SET card_filter = $1 WHERE pack_id = $2',
      [JSON.stringify({ ...existing, card_ids }), req.params.packId]);

    await logAction(req.user.id, 'DEV_CREATE_PACK_CARD', null, `${name} (${newId}) → ${req.params.packId}`);
    res.json({ id: newId, name, pack_id: req.params.packId });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Card name already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/dev/cards/promo', ...devAuth, async (req, res) => {
  try {
    const { name, type, cls, hp, atk, def, spd, ability_name, ability_desc, ability_power,
            rarity, shop_price, is_numbered, print_limit, expires_at, flavor_text, retreat_cost, weakness, resistance,
            set_name, art_style } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const maxId = await query('SELECT MAX(id) FROM cards');
    const newId = (maxId.rows[0].max || 10500) + 1;
    const wk = weakness || (WEAKNESS_MAP[type||'Fire'] || 'Water');
    const rs = resistance || (RESISTANCE_MAP[type||'Fire'] || 'Nature');
    await query(
      'INSERT INTO cards (id,name,type,class,hp,atk,def,spd,ability_name,ability_desc,ability_power,retreat_cost,weakness,resistance,rarity,is_numbered,set_name,flavor_text,art_style,card_number,shop_price,print_limit,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)',
      [newId, name, type||'Fire', cls||'Titan', hp||200, atk||100, def||80, spd||80,
       ability_name||'Promo Strike', ability_desc||'A legendary promo ability.', ability_power||130,
       retreat_cost||1, wk, rs,
       rarity||'Mythic', is_numbered||false,
       set_name||'Promo Series', flavor_text||'A special promotional creature.',
       art_style||'ink', `PROMO-${newId}`, shop_price||0, print_limit||null,
       expires_at ? new Date(expires_at) : null]
    );
    await logAction(req.user.id, 'DEV_PROMO_CARD', null, name);
    res.json({ message: 'Promo card created', id: newId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/economy', ...devAuth, async (req, res) => {
  try {
    const { pack_cost, daily_coins, win_coins } = req.body;
    const updates = [];
    if (pack_cost !== undefined) updates.push(['economy_pack_cost', String(pack_cost)]);
    if (daily_coins !== undefined) updates.push(['economy_daily_coins', String(daily_coins)]);
    if (win_coins !== undefined) updates.push(['economy_win_coins', String(win_coins)]);
    for (const [k, v] of updates) await query('INSERT INTO game_config (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()', [k, v]);
    await logAction(req.user.id, 'DEV_ECONOMY', null, JSON.stringify(req.body));
    res.json({ message: 'Economy updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dev/ranked/create-rank', ...devAuth, async (req, res) => {
  try {
    const { name, min_rating } = req.body;
    await query('INSERT INTO game_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
      ['custom_rank_' + name.toLowerCase().replace(/\s+/g,'_'), JSON.stringify({ name, min_rating })]);
    await logAction(req.user.id, 'DEV_CREATE_RANK', null, name);
    res.json({ message: 'Custom rank created' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dev/users/:id/collection/grant', ...devAuth, async (req, res) => {
  try {
    const { card_ids } = req.body;
    for (const cid of card_ids) {
      await query('INSERT INTO user_cards (user_id, card_id) VALUES ($1,$2) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_cards.quantity + 1', [req.params.id, cid]);
    }
    await logAction(req.user.id, 'DEV_GRANT_CARDS', req.params.id, card_ids.length + ' cards');
    res.json({ message: `${card_ids.length} cards granted` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dev/users/:id/collection', ...devAuth, async (req, res) => {
  try {
    const { search = '', page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * 30;
    const params = [req.params.id];
    let where = '';
    if (search) { where = 'AND (c.name ILIKE $2 OR c.type ILIKE $2 OR c.rarity ILIKE $2)'; params.push('%' + search + '%'); }
    const r = await query(`
      SELECT c.id, c.name, c.type, c.rarity, c.set_name, uc.quantity
      FROM user_cards uc JOIN cards c ON c.id = uc.card_id
      WHERE uc.user_id = $1 ${where}
      ORDER BY c.name ASC LIMIT 30 OFFSET ${offset}
    `, params);
    const total = await query(`SELECT COUNT(*) FROM user_cards uc JOIN cards c ON c.id=uc.card_id WHERE uc.user_id=$1 ${where}`, params);
    res.json({ cards: r.rows, total: parseInt(total.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Give any card (incl. promos) to self or any user — developer only
app.post('/api/dev/give', ...devAuth, async (req, res) => {
  try {
    const { card_id, card_name, username } = req.body;
    // Resolve card
    let cardRow;
    if (card_id) {
      const r = await query('SELECT * FROM cards WHERE id = $1', [parseInt(card_id)]);
      cardRow = r.rows[0];
    } else if (card_name) {
      const r = await query('SELECT * FROM cards WHERE LOWER(name) LIKE LOWER($1) LIMIT 1', [`%${card_name}%`]);
      cardRow = r.rows[0];
    }
    if (!cardRow) return res.status(404).json({ error: 'Card not found' });
    // Resolve target user (default = self)
    let targetId = req.user.id;
    let targetName = req.user.username;
    if (username) {
      const u = await query('SELECT id, username FROM users WHERE LOWER(username)=LOWER($1)', [username]);
      if (!u.rows.length) return res.status(404).json({ error: `User "${username}" not found` });
      targetId = u.rows[0].id;
      targetName = u.rows[0].username;
    }
    await query(
      'INSERT INTO user_cards (user_id, card_id) VALUES ($1,$2) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_cards.quantity + 1',
      [targetId, cardRow.id]
    );
    await logAction(req.user.id, 'DEV_GIVE', targetId, cardRow.name);
    const toSelf = targetId === req.user.id;
    res.json({ message: `"${cardRow.name}" given to ${toSelf ? 'your collection' : targetName}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dev/cards/search', ...devAuth, async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.json([]);
    const r = await query(
      `SELECT id, name, type, rarity, class, set_name FROM cards WHERE LOWER(name) LIKE LOWER($1) OR LOWER(set_name) LIKE LOWER($1) OR LOWER(type) LIKE LOWER($1) OR LOWER(rarity) LIKE LOWER($1) OR LOWER(class) LIKE LOWER($1) ORDER BY name LIMIT 30`,
      [`%${q}%`]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a card from a player — developer only
app.post('/api/dev/remove-card', ...devAuth, async (req, res) => {
  try {
    const { card_id, username, user_id } = req.body;
    if (!card_id || (!username && !user_id)) return res.status(400).json({ error: 'card_id and username or user_id required' });
    const u = user_id
      ? await query('SELECT id, username FROM users WHERE id=$1', [parseInt(user_id)])
      : await query('SELECT id, username FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const targetId = u.rows[0].id;
    const c = await query('SELECT name FROM cards WHERE id=$1', [parseInt(card_id)]);
    if (!c.rows.length) return res.status(404).json({ error: 'Card not found' });
    const del = await query('DELETE FROM user_cards WHERE user_id=$1 AND card_id=$2', [targetId, parseInt(card_id)]);
    if (del.rowCount === 0) return res.status(404).json({ error: `${u.rows[0].username} doesn't own that card` });
    await logAction(req.user.id, 'DEV_REMOVE_CARD', targetId, c.rows[0].name);
    res.json({ message: `"${c.rows[0].name}" removed from ${u.rows[0].username}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset a player's stats — developer only
app.post('/api/dev/reset-stats', ...devAuth, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const u = await query('SELECT id, username FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (!u.rows.length) return res.status(404).json({ error: `User "${username}" not found` });
    const targetId = u.rows[0].id;
    await query('UPDATE users SET coins=100 WHERE id=$1', [targetId]);
    await query('UPDATE ranked_stats SET rating=1000, rank_title=$1, wins=0, losses=0 WHERE user_id=$2', [rankTitle(1000), targetId]);
    await logAction(req.user.id, 'DEV_RESET_STATS', targetId, u.rows[0].username);
    res.json({ message: `Stats reset for ${u.rows[0].username}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dev/api-usage', ...devAuth, async (req, res) => {
  try {
    const stats = await query('SELECT action, COUNT(*) as count FROM admin_logs GROUP BY action ORDER BY count DESC LIMIT 50');
    res.json(stats.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dev/database/backup', ...devAuth, async (req, res) => {
  try {
    const tables = await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    const backup = {};
    for (const row of tables.rows) {
      const data = await query(`SELECT * FROM ${row.table_name} LIMIT 1000`);
      backup[row.table_name] = { count: data.rowCount, sample: data.rows.slice(0, 5) };
    }
    await logAction(req.user.id, 'DB_BACKUP', null, '');
    res.json({ message: 'Backup snapshot created', backup, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dev/matches/:id/end', ...devAuth, async (req, res) => {
  try {
    const { winner_id } = req.body;
    await query('UPDATE matches SET winner_id=$1 WHERE id=$2', [winner_id, req.params.id]);
    await logAction(req.user.id, 'FORCE_END_MATCH:' + req.params.id, winner_id, '');
    res.json({ message: 'Match ended' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PROFILE ROUTES ──────────────────────────────────────────────
app.get('/api/users/:username/profile', auth, async (req, res) => {
  try {
    const userRes = await query(`
      SELECT u.id, u.username, u.role, u.avatar_color, u.avatar_img, u.bio, u.created_at, u.custom_title,
             rs.rating, rs.rank_title, rs.wins, rs.losses, rs.top500, rs.season_wins, rs.season_losses,
             COUNT(uc.id)::int AS card_count
      FROM users u
      LEFT JOIN ranked_stats rs ON rs.user_id = u.id
      LEFT JOIN user_cards uc ON uc.user_id = u.id
      WHERE LOWER(u.username) = LOWER($1) AND u.banned = false
      GROUP BY u.id, rs.rating, rs.rank_title, rs.wins, rs.losses, rs.top500, rs.season_wins, rs.season_losses
    `, [req.params.username]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];
    const matchRes = await query(`
      SELECT m.id, m.winner_id, m.created_at, u2.username AS opponent
      FROM matches m LEFT JOIN users u2 ON u2.id = m.player2_id
      WHERE m.player1_id = $1 ORDER BY m.created_at DESC LIMIT 5
    `, [user.id]);
    res.json({ ...user, recent_matches: matchRes.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PROMO SHOP ROUTES ────────────────────────────────────────────
app.get('/api/shop/promos', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT c.*, (uc.card_id IS NOT NULL) AS owned FROM cards c
      LEFT JOIN user_cards uc ON uc.card_id = c.id AND uc.user_id = $1
      WHERE c.shop_price > 0
        AND (c.print_limit IS NULL OR c.print_count < c.print_limit)
        AND (c.expires_at IS NULL OR c.expires_at > NOW())
      ORDER BY c.id DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shop/promos/:id/buy', auth, async (req, res) => {
  try {
    const cardId = parseInt(req.params.id);
    const cardRes = await query("SELECT * FROM cards WHERE id = $1 AND shop_price > 0", [cardId]);
    if (!cardRes.rows.length) return res.status(404).json({ error: 'Promo not found' });
    const card = cardRes.rows[0];
    // Check if expired
    if (card.expires_at && new Date(card.expires_at) <= new Date()) {
      return res.status(400).json({ error: 'This promo has expired!' });
    }
    // Check if already owned
    const owned = await query('SELECT 1 FROM user_cards WHERE user_id=$1 AND card_id=$2', [req.user.id, cardId]);
    if (owned.rows.length) return res.status(400).json({ error: 'You already own this promo card!' });
    // Check if sold out
    if (card.is_numbered && card.print_limit !== null && card.print_count >= card.print_limit) {
      return res.status(400).json({ error: 'This card is sold out!' });
    }
    const price = card.shop_price;
    const userRes = await query("SELECT coins FROM users WHERE id = $1", [req.user.id]);
    if (userRes.rows[0].coins < price) return res.status(400).json({ error: 'Not enough coins' });
    await query("UPDATE users SET coins = coins - $1 WHERE id = $2", [price, req.user.id]);
    // Claim print number if limited numbered card
    let printNumber = null;
    if (card.is_numbered && card.print_limit !== null) {
      const claim = await query(
        'UPDATE cards SET print_count = print_count + 1 WHERE id = $1 AND print_count < print_limit RETURNING print_count',
        [cardId]
      );
      if (!claim.rows.length) return res.status(400).json({ error: 'This card just sold out!' });
      printNumber = claim.rows[0].print_count;
    }
    await query("INSERT INTO user_cards (user_id, card_id, print_number) VALUES ($1,$2,$3) ON CONFLICT (user_id,card_id) DO NOTHING", [req.user.id, cardId, printNumber]);
    res.json({ message: 'Promo card purchased!', card: cardRes.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STAFF CHAT ROUTES ────────────────────────────────────────────
const isStaff = (role) => ['mod','admin','headofstaff','owner','developer'].includes(role);

app.get('/api/staff/chat', auth, async (req, res) => {
  if (!isStaff(req.user.role)) return res.status(403).json({ error: 'Staff only' });
  try {
    const result = await query(`
      SELECT sm.id, sm.message, sm.created_at, u.username, u.role, u.avatar_color, u.avatar_img
      FROM staff_messages sm JOIN users u ON u.id = sm.user_id
      ORDER BY sm.created_at DESC LIMIT 100
    `);
    res.json(result.rows.reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/staff/chat', auth, async (req, res) => {
  if (!isStaff(req.user.role)) return res.status(403).json({ error: 'Staff only' });
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    await query("INSERT INTO staff_messages (user_id, message) VALUES ($1,$2)", [req.user.id, message.trim().slice(0,500)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fallback to index.html for SPA
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function start() {
  try {
    await initDB();
    await seedCards();
    await seedAdmin();
    await loadMaintenanceFlags();
    app.listen(PORT, () => console.log(`Mythical TCG running on http://localhost:${PORT}`));
  } catch (e) {
    console.error('Failed to start:', e);
    process.exit(1);
  }
}

start();
