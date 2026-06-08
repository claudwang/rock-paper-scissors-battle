const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3002;
const ROUND_TIME = 30;       // 每局倒计时秒数
const WIN_SCORE = 5;         // 先赢5局获胜
const RESULT_DELAY = 4;      // 每局结束后展示结果的秒数
const MATCH_OVER_DELAY = 6;  // 比赛结束后展示结果的秒数

// ==================== HTTP 静态文件服务 ====================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // 健康检查
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, waiting: waitingQueue.length }));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, 'public', urlPath);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ==================== WebSocket 服务 ====================
const wss = new WebSocket.Server({ server });

// RPS 规则：谁击败谁
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

// 游戏状态
const waitingQueue = [];          // 等待匹配的玩家队列
const rooms = new Map();          // 活跃房间 Map<roomId, Room>
let roomIdCounter = 0;

// ---- 房间类 ----
class Room {
  constructor(id, p1, p2) {
    this.id = id;
    this.players = [p1, p2];
    this.scores = [0, 0];
    this.currentRound = 0;
    this.choices = [null, null];   // 本局双方出牌
    this.timer = null;             // 本局倒计时 timeout
    this.resultTimer = null;       // 结果展示 timeout
    this.active = false;           // 本局是否正在进行
    this.matchOver = false;        // 比赛是否结束

    p1.room = this;
    p1.side = 0;
    p2.room = this;
    p2.side = 1;

    rooms.set(id, this);
    console.log(`[Room ${id}] 创建房间`);
  }

  // 获取对手
  opponentOf(ws) {
    return this.players[1 - ws.side];
  }

  // 广播给房间内所有人（从各自视角）
  sendBoth(msgFn) {
    this.players.forEach((p, i) => {
      if (p.readyState === WebSocket.OPEN) {
        p.send(JSON.stringify(msgFn(i)));
      }
    });
  }

  // 发给特定玩家
  sendTo(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // 开始新一局
  startRound() {
    this.currentRound++;
    this.choices = [null, null];
    this.active = true;

    console.log(`[Room ${this.id}] 第 ${this.currentRound} 局开始`);

    this.sendBoth((side) => ({
      type: 'round_start',
      round: this.currentRound,
      timeLeft: ROUND_TIME,
      myScore: this.scores[side],
      oppScore: this.scores[1 - side],
    }));

    // 30 秒倒计时
    this.timer = setTimeout(() => this.handleTimeout(), ROUND_TIME * 1000);
  }

  // 处理超时（有人没出牌）
  handleTimeout() {
    if (!this.active) return;
    console.log(`[Room ${this.id}] 第 ${this.currentRound} 局超时`);

    const c0 = this.choices[0];
    const c1 = this.choices[1];

    if (c0 !== null && c1 !== null) return; // 都已经出了，正常情况不该到这

    let winnerSide = null;
    if (c0 === null && c1 === null) {
      // 双方超时 → 平局
      winnerSide = -1;
    } else if (c0 === null) {
      winnerSide = 1; // P2 赢
    } else {
      winnerSide = 0; // P1 赢
    }

    this.resolveRound(
      c0 || 'timeout',
      c1 || 'timeout',
      winnerSide
    );
  }

  // 玩家出牌
  playCard(ws, card) {
    if (!this.active) return;
    if (!['rock', 'paper', 'scissors'].includes(card)) return;

    const side = ws.side;
    if (this.choices[side] !== null) return; // 已经出过了

    this.choices[side] = card;
    console.log(`[Room ${this.id}] P${side + 1} 出牌: ${card}`);

    // 告诉对手"已出牌"但不透露内容
    this.sendTo(this.opponentOf(ws), { type: 'opponent_played' });

    // 告诉出牌者确认
    this.sendTo(ws, { type: 'card_played', card });

    // 双方都出了 → 判定胜负
    if (this.choices[0] !== null && this.choices[1] !== null) {
      const result = this.judge(this.choices[0], this.choices[1]);
      this.resolveRound(this.choices[0], this.choices[1], result);
    }
  }

  // 判定胜负：返回 -1(平), 0(P1胜), 1(P2胜)
  judge(c1, c2) {
    if (c1 === c2) return -1;
    return BEATS[c1] === c2 ? 0 : 1;
  }

  // 结算本局
  resolveRound(c1, c2, winnerSide) {
    this.active = false;
    clearTimeout(this.timer);

    if (winnerSide === 0) this.scores[0]++;
    else if (winnerSide === 1) this.scores[1]++;

    const matchOver = this.scores[0] >= WIN_SCORE || this.scores[1] >= WIN_SCORE;

    console.log(`[Room ${this.id}] 第 ${this.currentRound} 局结果: P1=${c1} P2=${c2} winner=${winnerSide} scores=[${this.scores}]`);

    this.sendBoth((side) => {
      const myCard = side === 0 ? c1 : c2;
      const oppCard = side === 0 ? c2 : c1;

      let result;
      if (winnerSide === -1) result = 'draw';
      else if (winnerSide === side) result = 'win';
      else result = 'lose';

      return {
        type: 'round_result',
        round: this.currentRound,
        myCard,
        oppCard,
        result,
        myScore: this.scores[side],
        oppScore: this.scores[1 - side],
        matchOver,
      };
    });

    if (matchOver) {
      this.matchOver = true;
      this.resultTimer = setTimeout(() => {
        this.sendBoth((side) => ({
          type: 'match_over',
          winner: this.scores[0] >= WIN_SCORE ? 0 : 1,
          scores: this.scores,
          myScore: this.scores[side],
          oppScore: this.scores[1 - side],
        }));
        this.destroy();
      }, MATCH_OVER_DELAY * 1000);
    } else {
      this.resultTimer = setTimeout(() => this.startRound(), RESULT_DELAY * 1000);
    }
  }

  // 处理玩家断线
  handleDisconnect(ws) {
    clearTimeout(this.timer);
    clearTimeout(this.resultTimer);

    const opp = this.opponentOf(ws);
    this.sendTo(opp, { type: 'opponent_disconnected' });

    console.log(`[Room ${this.id}] P${ws.side + 1} 断线`);
    this.destroy();
  }

  // 销毁房间
  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.resultTimer);
    this.players.forEach((p) => {
      p.room = null;
      p.side = null;
    });
    rooms.delete(this.id);
    console.log(`[Room ${this.id}] 房间销毁`);
  }
}

// ==================== WebSocket 事件处理 ====================
wss.on('connection', (ws) => {
  const connTime = new Date().toISOString();
  console.log(`[连接] 新玩家 ${connTime}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.error('[消息] JSON 解析失败:', raw.toString().slice(0, 50));
      return;
    }

    console.log(`[消息] type=${msg.type}`);

    try {
    switch (msg.type) {

      // 寻找对战
      case 'find_match': {
        if (ws.room) return; // 已在房间中

        // 从等待队列移除（如果已在其中）
        const qi = waitingQueue.indexOf(ws);
        if (qi !== -1) waitingQueue.splice(qi, 1);

        if (waitingQueue.length > 0) {
          const opp = waitingQueue.shift();
          const room = new Room(++roomIdCounter, opp, ws);
          console.log(`[匹配] Room ${room.id} 匹配成功`);
          room.startRound();
        } else {
          waitingQueue.push(ws);
          safeSend(ws, { type: 'waiting' });
          console.log(`[匹配] 进入等待队列 (当前 ${waitingQueue.length} 人)`);
        }
        break;
      }

      // 出牌
      case 'play': {
        if (ws.room) {
          ws.room.playCard(ws, msg.card);
        }
        break;
      }

      // 取消匹配
      case 'cancel_match': {
        const ci = waitingQueue.indexOf(ws);
        if (ci !== -1) {
          waitingQueue.splice(ci, 1);
          safeSend(ws, { type: 'match_cancelled' });
          console.log('[匹配] 玩家取消匹配');
        }
        break;
      }

      // 心跳
      case 'ping': {
        safeSend(ws, { type: 'pong' });
        break;
      }
    }
    } catch (e) {
      console.error('[消息处理错误]', e.message, e.stack);
    }
  });

  ws.on('close', () => {
    console.log('[断开] 玩家离开');

    // 从等待队列移除
    const qi = waitingQueue.indexOf(ws);
    if (qi !== -1) {
      waitingQueue.splice(qi, 1);
      return;
    }

    // 处理房间中断线
    if (ws.room && !ws.room.matchOver) {
      ws.room.handleDisconnect(ws);
    }
  });

  ws.on('error', (err) => {
    console.error('[WebSocket 错误]', err.message);
  });
});

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ==================== 全局错误处理 ====================
server.on('error', (err) => {
  console.error('[服务器错误]', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请使用 PORT=XXXX 指定其他端口`);
    process.exit(1);
  }
});

wss.on('error', (err) => {
  console.error('[WebSocket 服务器错误]', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err.message, err.stack);
  // 不要退出，让服务器继续运行
});

process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 拒绝]', reason);
});

// ==================== 启动 ====================
server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('  石头剪刀布 · 卡牌对战服务器');
  console.log(`  端口: ${PORT}`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  规则: 先赢 ${WIN_SCORE} 局者胜 · 每局 ${ROUND_TIME}s`);
  console.log('='.repeat(50));
});
