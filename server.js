const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS 설정
app.use(cors());
app.use(express.json());

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 게임 서버 클래스
class GameServer {
  constructor() {
    this.games = new Map();
    this.players = new Map();
  }
  
  getOrCreateGame(gameId, settings = {}) {
    if (!this.games.has(gameId)) {
      const game = {
        id: gameId,
        players: new Map(),
        status: 'waiting',
        settings: {
          gameDuration: settings.gameDuration || 600000, // 10분
          eliminationRiskDuration: settings.eliminationRiskDuration || 100000, // 100초
          chaseCountdown: settings.chaseCountdown || 5000, // 5초
          mercenaryMultiplier: 3.0,
          ghostChaseCountdown: 3000, // 3초
          ...settings
        },
        timers: {
          gameTimer: null,
          eliminationRiskTimers: new Map(),
          chaseTimers: new Map()
        },
        startTime: null,
        endTime: null,
        createdAt: Date.now()
      };
      
      this.games.set(gameId, game);
      console.log(`[${gameId}] 새 게임 생성`);
    }
    
    return this.games.get(gameId);
  }
  
  joinGame(socketId, gameId, playerData) {
    const game = this.getOrCreateGame(gameId);
    const { playerId, playerName, role, ability } = playerData;
    
    this.players.set(socketId, {
      socketId,
      playerId,
      playerName,
      role,
      ability,
      gameId,
      joinedAt: Date.now()
    });
    
    game.players.set(playerId, {
      playerId,
      playerName,
      role,
      ability,
      socketId,
      status: 'alive',
      joinedAt: Date.now()
    });
    
    console.log(`[${gameId}] 플레이어 참가: ${playerId} (${playerName}, ${role})`);
    return game;
  }
  
  startGameTimer(gameId, customDuration = null) {
    const game = this.games.get(gameId);
    if (!game) return false;
    
    if (game.timers.gameTimer) {
      clearTimeout(game.timers.gameTimer);
    }
    
    const duration = customDuration || game.settings.gameDuration;
    const startTime = Date.now();
    
    game.startTime = startTime;
    game.endTime = startTime + duration;
    game.status = 'playing';
    
    game.timers.gameTimer = setTimeout(() => {
      this.endGame(gameId, 'timeout');
    }, duration);
    
    io.to(gameId).emit('game_timer_started', {
      gameId,
      duration,
      startTime,
      endTime: game.endTime,
      serverTime: Date.now()
    });
    
    console.log(`[${gameId}] 게임 타이머 시작: ${duration}ms`);
    return true;
  }
  
  startEliminationRiskTimer(gameId, playerId, customDuration = null) {
    const game = this.games.get(gameId);
    if (!game) return false;
    
    const player = game.players.get(playerId);
    if (!player) return false;
    
    let duration = customDuration || game.settings.eliminationRiskDuration;
    if (player.ability === 'MERCENARY') {
      duration = Math.floor(duration * game.settings.mercenaryMultiplier);
    }
    
    const startTime = Date.now();
    const endTime = startTime + duration;
    
    const existingTimer = game.timers.eliminationRiskTimers.get(playerId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    const timer = setTimeout(() => {
      this.eliminatePlayer(gameId, playerId, 'elimination_risk_timeout');
    }, duration);
    
    game.timers.eliminationRiskTimers.set(playerId, timer);
    player.status = 'elimination_risk';
    
    io.to(gameId).emit('elimination_risk_started', {
      gameId,
      playerId,
      duration,
      startTime,
      endTime,
      serverTime: Date.now(),
      isMercenary: player.ability === 'MERCENARY'
    });
    
    console.log(`[${gameId}] 탈락 위기 타이머 시작: ${playerId}, ${duration}ms`);
    return true;
  }
  
  stopEliminationRiskTimer(gameId, playerId) {
    const game = this.games.get(gameId);
    if (!game) return false;
    
    const timer = game.timers.eliminationRiskTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      game.timers.eliminationRiskTimers.delete(playerId);
      
      const player = game.players.get(playerId);
      if (player) {
        player.status = 'alive';
      }
      
      io.to(gameId).emit('elimination_risk_stopped', {
        gameId,
        playerId,
        serverTime: Date.now()
      });
      
      console.log(`[${gameId}] 탈락 위기 타이머 중단: ${playerId}`);
      return true;
    }
    
    return false;
  }
  
  startChaseCountdown(gameId, hunterId, survivorId, isGhostAbility = false) {
    const game = this.games.get(gameId);
    if (!game) return false;
    
    const duration = isGhostAbility ? 
      game.settings.ghostChaseCountdown : 
      game.settings.chaseCountdown;
    
    const startTime = Date.now();
    const timerKey = `${hunterId}_${survivorId}`;
    
    const existingTimer = game.timers.chaseTimers.get(timerKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    const timer = setTimeout(() => {
      this.chaseTimeout(gameId, hunterId, survivorId);
    }, duration);
    
    game.timers.chaseTimers.set(timerKey, timer);
    
    io.to(gameId).emit('chase_countdown_started', {
      gameId,
      hunterId,
      survivorId,
      duration,
      startTime,
      endTime: startTime + duration,
      serverTime: Date.now(),
      isGhostAbility
    });
    
    console.log(`[${gameId}] 추격 카운트다운 시작: ${hunterId} -> ${survivorId}, ${duration}ms (Ghost: ${isGhostAbility})`);
    return true;
  }
  
  stopChaseCountdown(gameId, hunterId, survivorId) {
    const game = this.games.get(gameId);
    if (!game) return false;
    
    const timerKey = `${hunterId}_${survivorId}`;
    const timer = game.timers.chaseTimers.get(timerKey);
    
    if (timer) {
      clearTimeout(timer);
      game.timers.chaseTimers.delete(timerKey);
      
      io.to(gameId).emit('chase_countdown_stopped', {
        gameId,
        hunterId,
        survivorId,
        serverTime: Date.now()
      });
      
      console.log(`[${gameId}] 추격 카운트다운 중단: ${hunterId} -> ${survivorId}`);
      return true;
    }
    
    return false;
  }
  
  chaseTimeout(gameId, hunterId, survivorId) {
    const game = this.games.get(gameId);
    if (!game) return;
    
    const timerKey = `${hunterId}_${survivorId}`;
    game.timers.chaseTimers.delete(timerKey);
    
    io.to(gameId).emit('chase_timeout', {
      gameId,
      hunterId,
      survivorId,
      serverTime: Date.now()
    });
    
    console.log(`[${gameId}] 추격 타임아웃: ${hunterId} -> ${survivorId}`);
  }
  
  eliminatePlayer(gameId, playerId, reason = 'unknown') {
    const game = this.games.get(gameId);
    if (!game) return false;
    
    const player = game.players.get(playerId);
    if (!player) return false;
    
    const timer = game.timers.eliminationRiskTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      game.timers.eliminationRiskTimers.delete(playerId);
    }
    
    player.status = 'eliminated';
    player.eliminatedAt = Date.now();
    player.eliminationReason = reason;
    
    io.to(gameId).emit('player_eliminated', {
      gameId,
      playerId,
      reason,
      timestamp: Date.now(),
      serverTime: Date.now()
    });
    
    console.log(`[${gameId}] 플레이어 탈락: ${playerId} (이유: ${reason})`);
    this.checkGameEndConditions(gameId);
    return true;
  }
  
  checkGameEndConditions(gameId) {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'playing') return;
    
    const aliveSurvivors = Array.from(game.players.values())
      .filter(p => p.role === 'survivor' && p.status !== 'eliminated');
    
    if (aliveSurvivors.length === 0) {
      this.endGame(gameId, 'all_survivors_eliminated');
    }
  }
  
  endGame(gameId, reason) {
    const game = this.games.get(gameId);
    if (!game) return false;
    
    game.status = 'ended';
    game.endedAt = Date.now();
    game.endReason = reason;
    
    if (game.timers.gameTimer) {
      clearTimeout(game.timers.gameTimer);
      game.timers.gameTimer = null;
    }
    
    game.timers.eliminationRiskTimers.forEach(timer => clearTimeout(timer));
    game.timers.eliminationRiskTimers.clear();
    
    game.timers.chaseTimers.forEach(timer => clearTimeout(timer));
    game.timers.chaseTimers.clear();
    
    io.to(gameId).emit('game_ended', {
      gameId,
      reason,
      endTime: game.endedAt,
      serverTime: Date.now()
    });
    
    console.log(`[${gameId}] 게임 종료: ${reason}`);
    
    setTimeout(() => {
      this.cleanupGame(gameId);
    }, 300000); // 5분 후 정리
    
    return true;
  }
  
  cleanupGame(gameId) {
    const game = this.games.get(gameId);
    if (!game) return;
    
    for (const [socketId, player] of this.players.entries()) {
      if (player.gameId === gameId) {
        this.players.delete(socketId);
      }
    }
    
    this.games.delete(gameId);
    console.log(`[${gameId}] 게임 데이터 정리 완료`);
  }
  
  disconnectPlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    
    const { gameId, playerId } = player;
    const game = this.games.get(gameId);
    
    if (game) {
      game.players.delete(playerId);
      
      const eliminationTimer = game.timers.eliminationRiskTimers.get(playerId);
      if (eliminationTimer) {
        clearTimeout(eliminationTimer);
        game.timers.eliminationRiskTimers.delete(playerId);
      }
      
      io.to(gameId).emit('player_disconnected', {
        gameId,
        playerId,
        serverTime: Date.now()
      });
      
      console.log(`[${gameId}] 플레이어 연결 해제: ${playerId}`);
    }
    
    this.players.delete(socketId);
  }
  
  getServerStats() {
    return {
      totalGames: this.games.size,
      totalPlayers: this.players.size,
      activeGames: Array.from(this.games.values()).filter(g => g.status === 'playing').length,
      waitingGames: Array.from(this.games.values()).filter(g => g.status === 'waiting').length
    };
  }
}

const gameServer = new GameServer();

// Socket.IO 이벤트 핸들러
io.on('connection', (socket) => {
  console.log(`플레이어 연결: ${socket.id}`);
  
  socket.on('join_game', (data) => {
    try {
      const { gameId, playerId, playerName, role, ability } = data;
      
      const game = gameServer.joinGame(socket.id, gameId, {
        playerId, playerName, role, ability
      });
      
      socket.join(gameId);
      
      socket.emit('joined_game', {
        success: true,
        gameId,
        playerId,
        gameStatus: game.status,
        serverTime: Date.now()
      });
      
      socket.to(gameId).emit('player_joined', {
        gameId,
        playerId,
        playerName,
        role,
        ability,
        serverTime: Date.now()
      });
      
    } catch (error) {
      console.error('게임 참가 오류:', error);
      socket.emit('error', { message: '게임 참가 실패', error: error.message });
    }
  });
  
  socket.on('start_game', (data) => {
    try {
      const { gameId, settings } = data;
      
      if (gameServer.startGameTimer(gameId, settings?.gameDuration)) {
        socket.emit('game_start_success', { gameId, serverTime: Date.now() });
      } else {
        socket.emit('error', { message: '게임 시작 실패' });
      }
    } catch (error) {
      console.error('게임 시작 오류:', error);
      socket.emit('error', { message: '게임 시작 실패', error: error.message });
    }
  });
  
  socket.on('start_elimination_risk', (data) => {
    try {
      const { gameId, playerId, duration } = data;
      
      if (gameServer.startEliminationRiskTimer(gameId, playerId, duration)) {
        socket.emit('elimination_risk_start_success', { gameId, playerId, serverTime: Date.now() });
      } else {
        socket.emit('error', { message: '탈락 위기 타이머 시작 실패' });
      }
    } catch (error) {
      console.error('탈락 위기 시작 오류:', error);
      socket.emit('error', { message: '탈락 위기 시작 실패', error: error.message });
    }
  });
  
  socket.on('stop_elimination_risk', (data) => {
    try {
      const { gameId, playerId } = data;
      
      if (gameServer.stopEliminationRiskTimer(gameId, playerId)) {
        socket.emit('elimination_risk_stop_success', { gameId, playerId, serverTime: Date.now() });
      } else {
        socket.emit('error', { message: '탈락 위기 타이머 중단 실패' });
      }
    } catch (error) {
      console.error('탈락 위기 중단 오류:', error);
      socket.emit('error', { message: '탈락 위기 중단 실패', error: error.message });
    }
  });
  
  socket.on('start_chase', (data) => {
    try {
      const { gameId, hunterId, survivorId, isGhostAbility } = data;
      
      if (gameServer.startChaseCountdown(gameId, hunterId, survivorId, isGhostAbility)) {
        socket.emit('chase_start_success', { gameId, hunterId, survivorId, serverTime: Date.now() });
      } else {
        socket.emit('error', { message: '추격 카운트다운 시작 실패' });
      }
    } catch (error) {
      console.error('추격 시작 오류:', error);
      socket.emit('error', { message: '추격 시작 실패', error: error.message });
    }
  });
  
  socket.on('stop_chase', (data) => {
    try {
      const { gameId, hunterId, survivorId } = data;
      
      if (gameServer.stopChaseCountdown(gameId, hunterId, survivorId)) {
        socket.emit('chase_stop_success', { gameId, hunterId, survivorId, serverTime: Date.now() });
      } else {
        socket.emit('error', { message: '추격 카운트다운 중단 실패' });
      }
    } catch (error) {
      console.error('추격 중단 오류:', error);
      socket.emit('error', { message: '추격 중단 실패', error: error.message });
    }
  });
  
  socket.on('eliminate_player', (data) => {
    try {
      const { gameId, playerId, reason } = data;
      
      if (gameServer.eliminatePlayer(gameId, playerId, reason)) {
        socket.emit('eliminate_success', { gameId, playerId, reason, serverTime: Date.now() });
      } else {
        socket.emit('error', { message: '플레이어 탈락 처리 실패' });
      }
    } catch (error) {
      console.error('플레이어 탈락 오류:', error);
      socket.emit('error', { message: '플레이어 탈락 실패', error: error.message });
    }
  });
  
  socket.on('end_game', (data) => {
    try {
      const { gameId, reason } = data;
      
      if (gameServer.endGame(gameId, reason)) {
        socket.emit('end_game_success', { gameId, reason, serverTime: Date.now() });
      } else {
        socket.emit('error', { message: '게임 종료 실패' });
      }
    } catch (error) {
      console.error('게임 종료 오류:', error);
      socket.emit('error', { message: '게임 종료 실패', error: error.message });
    }
  });
  
  socket.on('ping', () => {
    socket.emit('pong', { serverTime: Date.now() });
  });
  
  socket.on('disconnect', () => {
    console.log(`플레이어 연결 해제: ${socket.id}`);
    gameServer.disconnectPlayer(socket.id);
  });
});

// REST API
app.get('/health', (req, res) => {
  const stats = gameServer.getServerStats();
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    serverTime: Date.now(),
    uptime: process.uptime(),
    ...stats
  });
});

app.get('/games', (req, res) => {
  const games = Array.from(gameServer.games.entries()).map(([id, game]) => ({
    id,
    status: game.status,
    playerCount: game.players.size,
    startTime: game.startTime,
    endTime: game.endTime,
    createdAt: game.createdAt
  }));
  
  res.json({
    games,
    totalCount: games.length,
    serverTime: Date.now()
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'UWB Survival Game Server',
    version: '1.0.0',
    status: 'Running',
    serverTime: Date.now(),
    endpoints: {
      health: '/health',
      games: '/games',
      websocket: 'Socket.IO enabled'
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('🚀 UWB Survival Game Server Started!');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`🎮 Game list: http://localhost:${PORT}/games`);
  console.log('⚡ WebSocket ready for connections');
}); 