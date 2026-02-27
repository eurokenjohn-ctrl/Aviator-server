require('dotenv').config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* =========================
   DATABASE CONNECTION
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("✅ Connected to Railway PostgreSQL"))
  .catch(err => console.error("❌ DB Connection error", err.stack));

/* =========================
   RECEIPTS (JSON - OPTION A)
========================= */

const receiptsFile = path.join(__dirname, "receipts.json");

function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}

function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}

function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07"))
    return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

/* =========================
   AUTH ROUTES
========================= */

app.use(express.static(path.join(__dirname, "public")));

app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/signup', async (req, res) => {
  const { username, phone, pin, referralCode } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) {
    return res.status(400).json({ error: "Invalid phone format" });
  }
  try {
    const checkUser = await pool.query(
      'SELECT * FROM users WHERE phone = $1 OR username = $2',
      [formattedPhone, username]
    );

    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: 'Username or Phone number already in use' });
    }

    let actualReferralCode = null;
    if (referralCode) {
      const checkRef = await pool.query('SELECT username FROM users WHERE username = $1', [referralCode]);
      if (checkRef.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid referral code' });
      }
      actualReferralCode = referralCode;
    }

    await pool.query(
      'INSERT INTO users (username, phone, pin, balance, referral_code) VALUES ($1, $2, $3, 0, $4)',
      [username, formattedPhone, pin, actualReferralCode]
    );

    if (actualReferralCode) {
      await pool.query('UPDATE users SET balance = balance + 20 WHERE username = $1', [actualReferralCode]);
      const referrerUser = await pool.query('SELECT phone FROM users WHERE username = $1', [actualReferralCode]);
      if (referrerUser.rows.length > 0) {
        const referrerPhone = referrerUser.rows[0].phone;
        await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)", [referrerPhone, 20, 'referral_bonus', 'success']);
        await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [referrerPhone, `You received KSH 20 for referring ${username}.`]);
      }
    }

    res.json({ success: true, message: 'Signup successful' });

  } catch (err) {
    res.status(500).json({ error: 'Server error during signup' });
  }
});

app.post('/login', async (req, res) => {
  const { phone, pin } = req.body;
   const formattedPhone = formatPhone(phone);
  try {
    const user = await pool.query(
      'SELECT username, phone, balance FROM users WHERE phone = $1 AND pin = $2',
      [formattedPhone, pin]
    );

    if (user.rows.length > 0) {
      res.json({ success: true, user: user.rows[0] });
    } else {
      res.status(401).json({ error: 'Invalid phone or PIN' });
    }

  } catch (err) {
    res.status(500).json({ error: 'Server error during login' });
  }
});

app.post('/change-pin', async (req, res) => {
  const { phone, oldPin, newPin } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });
  
  if (!newPin || newPin.length !== 6) return res.status(400).json({ error: 'New PIN must be 6 characters' });

  try {
    const user = await pool.query(
      'SELECT * FROM users WHERE phone = $1 AND pin = $2',
      [formattedPhone, oldPin]
    );

    if (user.rows.length > 0) {
      await pool.query('UPDATE users SET pin = $1 WHERE phone = $2', [newPin, formattedPhone]);
      res.json({ success: true, message: 'PIN changed successfully' });
    } else {
      res.status(401).json({ error: 'Invalid old PIN' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error during PIN change' });
  }
});

app.post('/transactions-history', async (req, res) => {
  const { phone } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const tx = await pool.query(
      "SELECT amount, type, status, created_at FROM transactions WHERE phone = $1 AND type IN ('withdrawal', 'deposit') ORDER BY created_at DESC",
      [formattedPhone]
    );
    res.json({ success: true, transactions: tx.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching transactions' });
  }
});

app.post('/delete-account', async (req, res) => {
  const { phone, pin } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const user = await pool.query(
      'SELECT * FROM users WHERE phone = $1 AND pin = $2',
      [formattedPhone, pin]
    );

    if (user.rows.length > 0) {
      await pool.query('DELETE FROM users WHERE phone = $1', [formattedPhone]);
      res.json({ success: true, message: 'Account deleted successfully' });
    } else {
      res.status(401).json({ error: 'Invalid PIN' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error during account deletion' });
  }
});

app.post('/refresh-balance', async (req, res) => {
  const { phone } = req.body;
  const formattedPhone = formatPhone(phone);
  try {
    const user = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [formattedPhone]
    );

    if (user.rows.length > 0) {
      res.json({ success: true, balance: user.rows[0].balance });
    } else {
      res.status(404).json({ error: 'User not found' });
    }

  } catch (err) {
    res.status(500).json({ error: 'Server error fetching balance' });
  }
});

/* =========================
   BETTING & CASH OUT
========================= */

app.post('/bet', async (req, res) => {
  const { phone, amount, autoCashout } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone)
    return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const user = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [formattedPhone]
    );

    if (user.rows.length === 0)
      return res.status(404).json({ error: 'User not found' });

    let currentBalance = parseFloat(user.rows[0].balance);
    let betAmount = parseFloat(amount);

    if (currentBalance < betAmount)
      return res.status(400).json({ error: 'Insufficient balance' });

    const insertResult = await pool.query(
      'INSERT INTO bets (phone, amount, status) VALUES ($1, $2, $3) RETURNING id',
      [formattedPhone, betAmount, 'placed']
    );

    const betId = insertResult.rows[0].id;
    const betObj = { id: betId, phone: formattedPhone, amount: betAmount, autoCashout: autoCashout ? parseFloat(autoCashout) : null, cashedOut: false };
    
    // All new bets go to pendingBets and will be deducted & activated when the next round starts
    pendingBets.push(betObj);

    res.json({ success: true, balance: currentBalance, betId: betId });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error placing bet' });
  }
});

app.post('/cancel_bet', async (req, res) => {
  const { phone, betId } = req.body;
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const betResult = await pool.query("SELECT * FROM bets WHERE id = $1 AND phone = $2 AND status = 'placed'", [betId, formattedPhone]);
    if (betResult.rows.length === 0) return res.status(400).json({ error: 'Bet not found or already processed' });
    
    await pool.query("UPDATE bets SET status = 'cancelled' WHERE id = $1", [betId]);
    
    // Remove from in-memory arrays
    if (typeof activeBets !== 'undefined') activeBets = activeBets.filter(b => b.id !== betId);
    if (typeof pendingBets !== 'undefined') pendingBets = pendingBets.filter(b => b.id !== betId);

    const user = await pool.query('SELECT balance FROM users WHERE phone = $1', [formattedPhone]);
    res.json({ success: true, balance: parseFloat(user.rows[0].balance) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error cancelling bet' });
  }
});

app.post('/cashout', async (req, res) => {
  const { phone, amount, multiplier, betId } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone)
    return res.status(400).json({ error: 'Invalid phone format' });

  try {
    let winAmount = parseFloat(amount);
    let mult = parseFloat(multiplier);

    // If betId is provided, update the specific bet, otherwise update the latest placed bet for safety
    if (betId) {
      if (typeof activeBets !== 'undefined') {
        const bIndex = activeBets.findIndex(b => b.id === betId);
        if (bIndex >= 0) {
           if (activeBets[bIndex].cashedOut) return res.status(400).json({ error: 'Bet already cashed out' });
           activeBets[bIndex].cashedOut = true;
        }
      }
      const betCheck = await pool.query("SELECT * FROM bets WHERE id = $1 AND phone = $2 AND status = 'placed'", [betId, formattedPhone]);
      if (betCheck.rows.length === 0) return res.status(400).json({ error: 'Bet already cashed out or invalid' });
      
      await pool.query("UPDATE bets SET multiplier = $1, status = 'cashed_out' WHERE id = $2", [mult, betId]);
    } else {
      await pool.query(
        "UPDATE bets SET multiplier = $1, status = 'cashed_out' WHERE phone = $2 AND status = 'placed' AND id = (SELECT id FROM bets WHERE phone = $2 AND status = 'placed' ORDER BY id DESC LIMIT 1)",
        [mult, formattedPhone]
      );
    }

    await pool.query(
      'UPDATE users SET balance = balance + $1 WHERE phone = $2',
      [winAmount, formattedPhone]
    );

    await pool.query(
      'INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)',
      [formattedPhone, winAmount, 'win', 'success']
    );

    const user = await pool.query(
      'SELECT balance FROM users WHERE phone = $1',
      [formattedPhone]
    );

    res.json({ success: true, balance: parseFloat(user.rows[0].balance) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error cashing out' });
  }
});

app.post('/withdraw', async (req, res) => {
  const { phone, amount } = req.body;
  const formattedPhone = formatPhone(phone);
  
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });
  if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum withdrawal is KSH 100' });

  try {
    const user = await pool.query('SELECT balance FROM users WHERE phone = $1', [formattedPhone]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    let currentBalance = parseFloat(user.rows[0].balance);
    let withdrawAmount = parseFloat(amount);

    if (currentBalance < withdrawAmount) return res.status(400).json({ error: 'Insufficient balance' });

    await pool.query('UPDATE users SET balance = balance - $1 WHERE phone = $2', [withdrawAmount, formattedPhone]);
    
    // Save withdrawal in transactions table
    await pool.query(
      "INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'withdrawal', 'success')",
      [formattedPhone, withdrawAmount]
    );

    // Send notification
    await pool.query(
      "INSERT INTO notifications (phone, message) VALUES ($1, $2)",
      [formattedPhone, `Withdrawal of KSH ${withdrawAmount.toFixed(2)} was successful.`]
    );

    const updatedUser = await pool.query('SELECT balance FROM users WHERE phone = $1', [formattedPhone]);
    res.json({ success: true, balance: parseFloat(updatedUser.rows[0].balance) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during withdrawal' });
  }
});

/* =========================
   ADMIN DASHBOARD
========================= */

app.get('/admin/stats', async (req, res) => {
  const password = req.headers['authorization'];
  if (password !== '3462Abel@#') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
    const totalBalance = await pool.query('SELECT SUM(balance) FROM users');
    const totalBets = await pool.query('SELECT COUNT(*) FROM bets');
    
    res.json({ 
      success: true, 
      users: parseInt(totalUsers.rows[0].count),
      balance: parseFloat(totalBalance.rows[0].sum || 0),
      bets: parseInt(totalBets.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching stats' });
  }
});


/* =========================
   ADMIN ADDITIONAL ROUTES
========================= */
app.post('/admin/set-odds', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('next_multiplier', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value", [req.body.multiplier]);
    res.json({success: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/next-odd', async (req, res) => {
  try {
    const s = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'next_multiplier'");
    let mult = null;
    if(s.rows.length > 0 && s.rows[0].setting_value) {
      mult = parseFloat(s.rows[0].setting_value);
      await pool.query("UPDATE settings SET setting_value = '' WHERE setting_key = 'next_multiplier'");
      res.json({success: true, multiplier: mult});
    } else {
      res.json({success: true, multiplier: null});
    }
  } catch(e) { res.json({success: false}); }
});

app.get('/admin/users', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    const users = await pool.query("SELECT id, username, phone, pin, balance, status FROM users ORDER BY id DESC");
    res.json({success: true, users: users.rows});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/users/action', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  const { action, userId, amount } = req.body;
  try {
    if(action === 'delete') await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    else if(action === 'suspend') await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userId]);
    else if(action === 'activate') await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [userId]);
    else if(action === 'adjust') {
      await pool.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [amount, userId]);
      const u = await pool.query("SELECT phone FROM users WHERE id = $1", [userId]);
      if(u.rows.length > 0) {
        await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)", [u.rows[0].phone, amount, 'admin_adjustment', 'success']);
      }
    }
    res.json({success: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/users/adjust-by-phone', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  const { phone, amount } = req.body;
  
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });
  if (isNaN(amount)) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const user = await pool.query("SELECT id FROM users WHERE phone = $1", [formattedPhone]);
    if(user.rows.length === 0) return res.status(404).json({error: 'User not found'});
    
    await pool.query("UPDATE users SET balance = balance + $1 WHERE phone = $2", [amount, formattedPhone]);
    await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, $3, $4)", [formattedPhone, amount, 'admin_adjustment', 'success']);
    
    res.json({success: true});
  } catch(e) { 
    res.status(500).json({error: e.message}); 
  }
});

app.get('/admin/transactions', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  try {
    const tx = await pool.query("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100");
    res.json({success: true, transactions: tx.rows});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/admin/send-notification', async (req, res) => {
  const pwd = req.headers['authorization'];
  if(pwd !== '3462Abel@#') return res.status(401).json({error: 'Unauthorized'});
  const { target, phone, message } = req.body;
  try {
    let count = 0;
    if(target === 'all') {
      const users = await pool.query("SELECT phone FROM users WHERE status = 'active'");
      for(const u of users.rows) {
        await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [u.phone, message]);
        count++;
      }
    } else if(target === 'specific' && phone) {
      await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [phone, message]);
      count = 1;
    }
    res.json({success: true, count});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/notifications', async (req, res) => {
  const { phone } = req.query;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone)
    return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const notifs = await pool.query(
      "SELECT * FROM notifications WHERE phone = $1 ORDER BY created_at DESC LIMIT 50",
      [formattedPhone]
    );

    res.json({ success: true, notifications: notifs.rows });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  const { phone } = req.body;

  const formattedPhone = formatPhone(phone);
  if (!formattedPhone)
    return res.status(400).json({ error: 'Invalid phone format' });

  try {
    await pool.query(
      "UPDATE notifications SET is_read = true WHERE phone = $1",
      [formattedPhone]
    );

    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   REFERRAL SYSTEM
========================= */

app.get('/api/referrals', async (req, res) => {
  const { phone } = req.query;
  const formattedPhone = formatPhone(phone);
  
  if (!formattedPhone) return res.status(400).json({ error: 'Invalid phone format' });

  try {
    const userResult = await pool.query('SELECT username, referral_code FROM users WHERE phone = $1', [formattedPhone]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    const user = userResult.rows[0];
    
    // Get people referred by this user
    const referredUsersResult = await pool.query(
      'SELECT username, created_at FROM users WHERE referral_code = $1 ORDER BY created_at DESC', 
      [user.username]
    );
    
    // Get earnings from referrals (both joining bonus and deposit commissions)
    const earningsResult = await pool.query(
      "SELECT SUM(amount) as total_earned FROM transactions WHERE phone = $1 AND type IN ('referral_bonus', 'referral_commission') AND status = 'success'",
      [formattedPhone]
    );
    
    // Get total deposits by referred users
    let totalDeposits = 0;
    if (referredUsersResult.rows.length > 0) {
      const referredUsernames = referredUsersResult.rows.map(r => r.username);
      // Get their phones to query transactions
      const referredPhonesResult = await pool.query(
        'SELECT phone FROM users WHERE username = ANY($1)',
        [referredUsernames]
      );
      const referredPhones = referredPhonesResult.rows.map(r => r.phone);
      
      if (referredPhones.length > 0) {
        const depositsResult = await pool.query(
          "SELECT SUM(amount) as total FROM transactions WHERE phone = ANY($1) AND type = 'deposit' AND status = 'success'",
          [referredPhones]
        );
        totalDeposits = parseFloat(depositsResult.rows[0].total || 0);
      }
    }
    
    res.json({
      success: true,
      referred_by: user.referral_code,
      referral_link: `https://swiftcrash.com/?ref=${user.username}`,
      referrals: referredUsersResult.rows,
      active_referrals: referredUsersResult.rows.length,
      total_deposits: totalDeposits,
      total_earned: parseFloat(earningsResult.rows[0].total_earned || 0)
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   GAME ENGINE & SSE
========================= */

let clients = [];
let gameStatus = 'WAITING';
let currentMultiplier = 1.00;
let currentCrashPoint = 1.00;
let oddsHistory = [];
let activeBets = [];
let pendingBets = [];

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  // Send initial state
  res.write(`data: ${JSON.stringify({ status: gameStatus, multiplier: currentMultiplier, history: oddsHistory })}\n\n`);
  
  clients.push(res);
  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => c.write(msg));
}

async function getNextCrashPoint() {
   try {
     const s = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'next_multiplier'");
     if(s.rows.length > 0 && s.rows[0].setting_value) {
       let mult = parseFloat(s.rows[0].setting_value);
       await pool.query("UPDATE settings SET setting_value = '' WHERE setting_key = 'next_multiplier'");
       return mult;
     }
   } catch(e) {}
   
   try {
     const listQuery = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'odds_list'");
     if(listQuery.rows.length > 0 && listQuery.rows[0].setting_value) {
        let list = listQuery.rows[0].setting_value.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
        if(list.length > 0) {
           return list[Math.floor(Math.random() * list.length)];
        }
     }
   } catch(e) {}
   
   const rand = Math.random();
   let cp;
   if (rand < 0.5) {
      // 50% chance: 1.00 - 5.00 (Common)
      cp = 1.00 + Math.random() * 4.00;
   } else if (rand < 0.8) {
      // 30% chance: 5.00 - 50.00 (Professional range)
      cp = 5.00 + Math.random() * 45.00;
   } else if (rand < 0.95) {
      // 15% chance: 50.00 - 100.00 (Exciting range)
      cp = 50.00 + Math.random() * 50.00;
   } else {
      // 5% chance: 100.00 - 150.00 (Jackpot range)
      cp = 100.00 + Math.random() * 50.00;
   }
   return parseFloat(cp.toFixed(2));
}

async function runGameLoop() {
   gameStatus = 'WAITING';
   currentMultiplier = 1.00;
   broadcast({ status: 'WAITING', time: 6, history: oddsHistory });
   
   let waitTime = 6;
   let waitInt = setInterval(() => {
      waitTime--;
      broadcast({ status: 'WAITING', time: waitTime, history: oddsHistory });
      if(waitTime <= 0) clearInterval(waitInt);
   }, 1000);
   
   await new Promise(r => setTimeout(r, 6000));
   
   // Move pending to active and deduct balances for the new round
   for (let i = 0; i < pendingBets.length; i++) {
     let bet = pendingBets[i];
     try {
       const userRes = await pool.query('SELECT balance FROM users WHERE phone = $1', [bet.phone]);
       if (userRes.rows.length > 0) {
         let bal = parseFloat(userRes.rows[0].balance);
         if (bal >= bet.amount) {
           await pool.query('UPDATE users SET balance = balance - $1 WHERE phone = $2', [bet.amount, bet.phone]);
           await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'bet', 'success')", [bet.phone, bet.amount]);
           activeBets.push(bet);
         } else {
           await pool.query("UPDATE bets SET status = 'cancelled' WHERE id = $1", [bet.id]);
         }
       }
     } catch (e) {
       console.error("Error processing pending bet:", e);
     }
   }
   pendingBets = [];

   gameStatus = 'RUNNING';
   currentCrashPoint = await getNextCrashPoint();
   
   let startTime = Date.now();
   
   let gameInterval = setInterval(() => {
      let elapsedSec = (Date.now() - startTime) / 1000;
      // Exponential curve: e^(0.08 * t). This makes it start slow and grow faster.
      currentMultiplier = Math.max(1.00, Math.exp(0.08 * elapsedSec));
      
      // Auto cashout check
      activeBets.forEach(async (bet) => {
         if (bet.autoCashout && currentMultiplier >= bet.autoCashout && !bet.cashedOut) {
            bet.cashedOut = true;
            const winAmount = bet.amount * bet.autoCashout;
            try {
               await pool.query("UPDATE bets SET multiplier = $1, status = 'cashed_out' WHERE id = $2", [bet.autoCashout, bet.id]);
               await pool.query('UPDATE users SET balance = balance + $1 WHERE phone = $2', [winAmount, bet.phone]);
               await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'win', 'success')", [bet.phone, winAmount]);
            } catch(e) {}
         }
      });

      if (currentMultiplier >= currentCrashPoint) {
         clearInterval(gameInterval);
         currentMultiplier = currentCrashPoint;
         gameStatus = 'CRASHED';
         
         // Mark remaining active bets as lost
         try {
             const lostIds = activeBets.filter(b => !b.cashedOut).map(b => b.id);
             if (lostIds.length > 0) {
                 pool.query("UPDATE bets SET status = 'lost' WHERE id = ANY($1)", [lostIds]).catch(()=>{});
             }
         } catch(e) {}
         
         // Bets that were placed during the RUNNING phase are already in pendingBets
         // They will be processed and deducted at the start of the next runGameLoop
         activeBets = [];

         oddsHistory.unshift(currentCrashPoint.toFixed(2));
         if(oddsHistory.length > 15) oddsHistory.pop();
         
         broadcast({ status: 'CRASHED', multiplier: currentMultiplier, history: oddsHistory });
         
         setTimeout(() => {
            runGameLoop();
         }, 3000);
      } else {
         broadcast({ status: 'RUNNING', multiplier: currentMultiplier });
      }
   }, 50);
}

// Start game engine only after DB connects
pool.connect().then(() => runGameLoop()).catch(err => console.log(err));

/* =========================
   STK PAYMENT ROUTES
========================= */

app.post("/pay", async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone)
      return res.status(400).json({ success: false, error: "Invalid phone format" });

    if (!amount || amount < 1)
      return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    const payload = {
      amount: Math.round(amount),
      phone_number: formattedPhone,
      external_reference: reference,
      customer_name: "Customer",
      callback_url: process.env.BASE_URL + "/callback",
      channel_id: "000603"
    };

    const resp = await axios.post(
      "https://swiftwallet.co.ke/v3/stk-initiate/",
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.SWIFTWALLET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (resp.data.success) {
      const receiptData = {
        reference,
        amount: Math.round(amount),
        phone: formattedPhone,
        status: "pending",
        timestamp: new Date().toISOString()
      };

      let receipts = readReceipts();
      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({ success: true, reference });

    } else {
      res.status(400).json({
        success: false,
        error: resp.data.error || "Failed to initiate payment"
      });
    }

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || "Server error"
    });
  }
});

app.post("/callback", async (req, res) => {
  const data = req.body;
  const ref = data.external_reference;

  let receipts = readReceipts();
  const existingReceipt = receipts[ref] || {};
  const resultCode = data.result?.ResultCode;

  if (resultCode === 0) {

    receipts[ref] = {
      ...existingReceipt,
      status: "success",
      transaction_code: data.result?.MpesaReceiptNumber || null,
      amount: data.result?.Amount || existingReceipt.amount,
      phone: data.result?.Phone || existingReceipt.phone,
      timestamp: new Date().toISOString()
    };

    writeReceipts(receipts);

    // ✅ DIRECT DATABASE UPDATE (NO HTTP CALL)
    try {
      await pool.query(
        'UPDATE users SET balance = balance + $1 WHERE phone = $2',
        [receipts[ref].amount, receipts[ref].phone]
      );
      await pool.query('INSERT INTO transactions (phone, amount, type, reference, status) VALUES ($1, $2, $3, $4, $5)', 
        [receipts[ref].phone, receipts[ref].amount, 'deposit', ref, 'success']);
      await pool.query('INSERT INTO notifications (phone, message) VALUES ($1, $2)',
        [receipts[ref].phone, `Your deposit of KSH ${receipts[ref].amount} was successful.`]);

      // Process Referral Commission (5%)
      const userRes = await pool.query('SELECT username, referral_code FROM users WHERE phone = $1', [receipts[ref].phone]);
      if (userRes.rows.length > 0 && userRes.rows[0].referral_code) {
        const referrerUsername = userRes.rows[0].referral_code;
        const commission = receipts[ref].amount * 0.05;
        
        await pool.query('UPDATE users SET balance = balance + $1 WHERE username = $2', [commission, referrerUsername]);
        
        const referrerRes = await pool.query('SELECT phone FROM users WHERE username = $1', [referrerUsername]);
        if (referrerRes.rows.length > 0) {
           const referrerPhone = referrerRes.rows[0].phone;
           await pool.query("INSERT INTO transactions (phone, amount, type, status) VALUES ($1, $2, 'referral_commission', 'success')", [referrerPhone, commission]);
           await pool.query("INSERT INTO notifications (phone, message) VALUES ($1, $2)", [referrerPhone, `You received KSH ${commission.toFixed(2)} commission from ${userRes.rows[0].username}'s deposit.`]);
        }
      }

      console.log("✅ Balance updated in PostgreSQL");
    } catch (err) {
      console.error("❌ DB update failed:", err.message);
    }

  } else {
    receipts[ref] = {
      ...existingReceipt,
      status: "failed",
      timestamp: new Date().toISOString()
    };
    writeReceipts(receipts);
  }

  res.json({ ResultCode: 0, ResultDesc: "Callback received" });
});

/* =========================
   RECEIPT ROUTES
========================= */

app.get("/receipt/:reference", (req, res) => {
  const { reference } = req.params;
  const receipts = readReceipts();
  const receipt = receipts[reference];

  if (!receipt) {
    return res.status(404).json({ success: false, error: "Receipt not found" });
  }

  res.json({ success: true, receipt });
});

app.get("/receipt/:reference/pdf", (req, res) => {
  const { reference } = req.params;
  const receipts = readReceipts();
  const receipt = receipts[reference];

  if (!receipt) {
    return res.status(404).json({ error: "Receipt not found" });
  }

  const doc = new PDFDocument();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${reference}.pdf`);
  doc.pipe(res);

  doc.fontSize(18).text("Payment Receipt", { align: "center" });
  doc.moveDown();
  doc.text(`Reference: ${receipt.reference}`);
  doc.text(`Phone: ${receipt.phone}`);
  doc.text(`Amount: KES ${receipt.amount}`);
  doc.text(`Status: ${receipt.status}`);
  doc.text(`Transaction Code: ${receipt.transaction_code || "N/A"}`);
  doc.text(`Date: ${receipt.timestamp}`);

  doc.end();
});

app.listen(PORT, () => {
  console.log(`🚀 Unified Server running on port ${PORT}`);
});

/* =========================
   EXPORT FOR BRIDGE
========================= */
if (require.main !== module) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
