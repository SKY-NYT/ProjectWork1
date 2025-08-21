require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const moment = require('moment');
const axios = require('axios');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const rateLimiter = require('./utils/rateLimiter');
const zoomRequestQueue = require('./utils/zoomRequestQueue');
const RealTimeZoomTracker = require('./services/realTimeZoomTracker');
const AttendanceTracker = require('./services/attendanceTracker');
const ZoomMeeting = require('./models/ZoomMeeting');
const SystemHealthChecker = require('./services/systemHealthChecker');
const authRoutes = require('./routes/auth');
const StudentRoutes = require('./routes/Student');
const participantsRoutes = require('./routes/participants');
const attendanceRoutes = require('./routes/Attendance');
const zoomRoutes = require('./routes/zoom');
const zoomEnhancedRoutes = require('./routes/zoom-enhanced');
const simpleZoomRoutes = require('./routes/simpleZoom');
const realtimeRoutes = require('./routes/realtime');
const meetingsRoutes = require('./routes/meetings');
const attendanceReportsRoutes = require('./routes/attendance-reports');
const attendanceTrackerRoutes = require('./routes/attendanceTracker');
const { router: userSessionRoutes, userSessionManager } = require('./routes/userSessions');
const { router: zoomWebhookRoutes, initializeWebhookRoutes } = require('./routes/zoomWebhooks');
const enhancedAttendanceRoutes = require('./routes/enhancedAttendanceRoutes');
const zoomClearRoutes = require('./routes/zoomClear');
const zoomDurationAttendanceRoutes = require('./routes/zoomDurationAttendance');
const attendanceTracker85Routes = require('./routes/attendanceTracker85');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json());
app.use(cookieParser()); // Add cookie parser middleware

const allowedOrigins = [
  process.env.REACT_APP_FRONTEND_URL,
  'https://project-work1-front.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000'
].filter(Boolean);

// CORS Options - Enhanced configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    console.log(`🌐 CORS request from origin: ${origin}`);
    if (allowedOrigins.includes(origin)) {
      console.log(`✅ CORS allowed for origin: ${origin}`);
      callback(null, true);
    } else {
      console.log(`❌ CORS blocked for origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'Accept', 
    'Origin', 
    'X-Requested-With',
    'Cache-Control',
    'Pragma',
    'Expires',
    'If-Modified-Since',
    'If-None-Match'
  ],
  exposedHeaders: ['Set-Cookie', 'Content-Length', 'Content-Type'],
  credentials: true,
  optionsSuccessStatus: 200,
  preflightContinue: false
};

app.use(cors(corsOptions));

// Enable pre-flight requests for all routes
app.options('*', cors(corsOptions));

// Additional security headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Expose-Headers', 'Set-Cookie');
  next();
});

// Connect to MongoDB
connectDB();

// Function to get OAuth access token for Zoom API with rate limiting
const getZoomAccessToken = async () => {
  return await rateLimiter.getAccessToken(async () => {
    const response = await axios.post(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`,
      {},
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000 // 30 second timeout
      }
    );
    return response.data.access_token;
  });
};

// Global state for real-time tracking
const globalState = {
  activeMeetings: new Map(),
  activeParticipants: new Map(),
  notifications: [],
  meetingAnalytics: {
    totalMeetings: 0,
    activeNow: 0,
    totalParticipants: 0
  },
  joinTracking: []
};

// Socket.IO setup with enhanced configuration for WebSocket connections
const io = socketIo(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || "http://localhost:5173",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:3000",
      "*" // Allow all origins for development - remove in production
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With"]
  },
  // Enhanced Socket.IO options
  transports: ['websocket', 'polling'], // Enable both transports
  allowEIO3: true, // Allow Engine.IO v3 clients
  pingTimeout: 60000, // 60 seconds
  pingInterval: 25000, // 25 seconds
  upgradeTimeout: 10000, // 10 seconds
  maxHttpBufferSize: 1e6, // 1MB
  allowRequest: (req, callback) => {
    // Allow all connections for now - add authentication logic here if needed
    callback(null, true);
  }
});

// Make io and globalState accessible to routes
app.set('io', io);
app.set('globalState', globalState);

// Make io and app globally accessible for health checker
global.io = io;
global.app = app;

// Socket.IO connection handling with enhanced error handling
io.on('connection', (socket) => {
  console.log(`🔗 User connected: ${socket.id} from ${socket.handshake.address}`);
  
  // Send current state to newly connected client
  socket.emit('initialState', {
    activeMeetings: Array.from(globalState.activeMeetings.values()),
    activeParticipants: Array.from(globalState.activeParticipants.values()),
    meetingAnalytics: globalState.meetingAnalytics,
    recentNotifications: globalState.notifications.slice(-10)
  });

  // Handle connection errors
  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
  
  // Handle connect errors
  socket.on('connect_error', (error) => {
    console.error(`❌ Socket connection error for ${socket.id}:`, error);
  });

  // Handle joining a meeting room
  socket.on('joinMeeting', (meetingId) => {
    socket.join(`meeting_${meetingId}`);
    console.log(`👥 User ${socket.id} joined meeting room: ${meetingId}`);
    
    // Notify others in the meeting
    socket.to(`meeting_${meetingId}`).emit('userJoinedRoom', {
      userId: socket.id,
      timestamp: new Date().toISOString()
    });
  });

  // Handle leaving a meeting room
  socket.on('leaveMeeting', (meetingId) => {
    socket.leave(`meeting_${meetingId}`);
    console.log(`👋 User ${socket.id} left meeting room: ${meetingId}`);
    
    // Notify others in the meeting
    socket.to(`meeting_${meetingId}`).emit('userLeftRoom', {
      userId: socket.id,
      timestamp: new Date().toISOString()
    });
  });

  // Handle participant status updates
  socket.on('participantUpdate', (data) => {
    const { meetingId, participantData } = data;
    
    // Update global state
    globalState.activeParticipants.set(participantData.id, {
      ...participantData,
      lastUpdate: new Date().toISOString()
    });
    
    // Broadcast to all clients in the meeting
    io.to(`meeting_${meetingId}`).emit('participantStatusUpdate', {
      participant: participantData,
      timestamp: new Date().toISOString()
    });
    
    // Send notification
    const notification = {
      id: Date.now(),
      type: 'participant_update',
      title: 'Participant Update',
      message: `${participantData.name} status: ${participantData.attendanceStatus}`,
      timestamp: new Date().toISOString(),
      meetingId
    };
    
    addNotification(notification);
    io.emit('notification', notification);
  });

  // Handle meeting events
  socket.on('meetingEvent', (data) => {
    const { meetingId, eventType, eventData } = data;
    
    // Broadcast meeting events
    io.to(`meeting_${meetingId}`).emit('meetingEventUpdate', {
      eventType,
      eventData,
      timestamp: new Date().toISOString()
    });
    
    // Create notification for important events
    if (['meeting_started', 'meeting_ended', 'participant_joined', 'participant_left'].includes(eventType)) {
      const notification = {
        id: Date.now(),
        type: 'meeting_event',
        title: getEventTitle(eventType),
        message: getEventMessage(eventType, eventData),
        timestamp: new Date().toISOString(),
        meetingId
      };
      
      addNotification(notification);
      io.emit('notification', notification);
    }
  });

  // Handle real-time analytics requests
  socket.on('getAnalytics', (meetingId) => {
    const analytics = generateMeetingAnalytics(meetingId);
    socket.emit('analyticsUpdate', analytics);
  });

  // 85% Attendance Tracker WebSocket Handlers
  socket.on('subscribe85AttendanceTracker', (data) => {
    const { meetingId, options } = data;
    console.log(`📊 Client ${socket.id} subscribing to 85% attendance tracker for meeting ${meetingId}`);
    
    try {
      // Subscribe client to attendance tracker updates
      global.attendanceTracker85WS.subscribeClient(socket, meetingId);
      
      // Start tracking if not already started
      global.attendanceTracker85WS.startTracking(io, meetingId, options?.interval || 10000);
      
      // Send initial data
      global.attendanceTracker85WS.getAttendanceData(meetingId, options)
        .then(initialData => {
          socket.emit('attendance85Initial', {
            meetingId,
            data: initialData,
            timestamp: new Date().toISOString()
          });
        })
        .catch(error => {
          socket.emit('attendance85Error', {
            meetingId,
            error: error.message,
            timestamp: new Date().toISOString()
          });
        });
      
      // Confirm subscription
      socket.emit('attendance85Subscribed', {
        meetingId,
        message: '85% attendance tracker subscription successful',
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error(`❌ Error subscribing to 85% attendance tracker:`, error);
      socket.emit('attendance85Error', {
        meetingId,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  socket.on('unsubscribe85AttendanceTracker', (data) => {
    const { meetingId } = data;
    console.log(`📊 Client ${socket.id} unsubscribing from 85% attendance tracker for meeting ${meetingId}`);
    
    try {
      // Unsubscribe client from attendance tracker updates
      global.attendanceTracker85WS.unsubscribeClient(socket, meetingId);
      
      // Confirm unsubscription
      socket.emit('attendance85Unsubscribed', {
        meetingId,
        message: '85% attendance tracker unsubscribed successfully',
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error(`❌ Error unsubscribing from 85% attendance tracker:`, error);
      socket.emit('attendance85Error', {
        meetingId,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  socket.on('get85AttendanceStatus', (data) => {
    const { meetingId } = data;
    
    try {
      const status = global.attendanceTracker85WS.getTrackingStatus();
      socket.emit('attendance85Status', {
        meetingId,
        status,
        isTracked: status.activeMeetings.includes(meetingId),
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error(`❌ Error getting 85% attendance status:`, error);
      socket.emit('attendance85Error', {
        meetingId,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    
    // Clean up any 85% attendance tracker subscriptions
    try {
      const trackingStatus = global.attendanceTracker85WS.getTrackingStatus();
      trackingStatus.activeMeetings.forEach(meetingId => {
        global.attendanceTracker85WS.unsubscribeClient(socket, meetingId);
      });
    } catch (error) {
      console.warn('Warning: Error cleaning up 85% attendance subscriptions:', error);
    }
  });
});

// Helper functions
function addNotification(notification) {
  globalState.notifications.push(notification);
  // Keep only last 100 notifications
  if (globalState.notifications.length > 100) {
    globalState.notifications = globalState.notifications.slice(-100);
  }
}

function getEventTitle(eventType) {
  const titles = {
    'meeting_started': '🎥 Meeting Started',
    'meeting_ended': '🔚 Meeting Ended',
    'participant_joined': '👋 Participant Joined',
    'participant_left': '👋 Participant Left'
  };
  return titles[eventType] || '📋 Meeting Update';
}

function getEventMessage(eventType, eventData) {
  switch (eventType) {
    case 'meeting_started':
      return `Meeting "${eventData.topic}" has started`;
    case 'meeting_ended':
      return `Meeting "${eventData.topic}" has ended`;
    case 'participant_joined':
      return `${eventData.name} joined the meeting`;
    case 'participant_left':
      return `${eventData.name} left the meeting`;
    default:
      return 'Meeting event occurred';
  }
}

function generateMeetingAnalytics(meetingId) {
  const meeting = globalState.activeMeetings.get(meetingId);
  if (!meeting) return null;
  
  const participants = Array.from(globalState.activeParticipants.values())
    .filter(p => p.meetingId === meetingId);
  
  return {
    meetingId,
    totalParticipants: participants.length,
    activeParticipants: participants.filter(p => p.isActive).length,
    attendanceRate: participants.length > 0 
      ? Math.round((participants.filter(p => p.attendancePercentage >= 75).length / participants.length) * 100)
      : 0,
    averageDuration: participants.length > 0
      ? Math.round(participants.reduce((sum, p) => sum + (p.duration || 0), 0) / participants.length)
      : 0,
    lastUpdate: new Date().toISOString()
  };
}

// Scheduled tasks for cleanup and analytics
cron.schedule('0 * * * *', async () => {
  // Clean up stale data and process meetings every hour
  const cutoffTime = moment().subtract(1, 'hour').toISOString();
  
  for (const [key, participant] of globalState.activeParticipants.entries()) {
    if (participant.lastUpdate < cutoffTime) {
      globalState.activeParticipants.delete(key);
    }
  }
  
  console.log(`🧹 Cleaned up stale participant data. Active participants: ${globalState.activeParticipants.size}`);

  // Fetch and process Zoom meetings with rate limiting
  try {
    const meetings = await ZoomMeeting.find({ status: 'started', reportGenerated: false });
    
    if (meetings.length === 0) {
      console.log('📊 No active meetings to process');
      return;
    }
    
    console.log(`📊 Processing ${meetings.length} active meetings...`);
    
    for (let meeting of meetings) {
      try {
        const zoomAccessToken = await getZoomAccessToken();
        
        // Use enhanced request queue for reports API call
        const response = await zoomRequestQueue.enqueue(
          async () => {
            return await rateLimiter.executeApiCall(
              async () => {
                return await axios.get(
                  `https://api.zoom.us/v2/report/meetings/${meeting.meetingId}/participants`,
                  {
                    headers: { Authorization: `Bearer ${zoomAccessToken}` },
                    timeout: 15000
                  }
                );
              },
              `report-participants-${meeting.meetingId}`,
              {
                isReportsCall: true,
                cacheKey: `participants-${meeting.meetingId}`,
                cacheTTL: 120, // 2 minutes cache for reports
                retryCount: 2
              }
            );
          },
          {
            category: 'report',
            priority: 4, // Lower priority for scheduled tasks
            identifier: `cron-report-participants-${meeting.meetingId}`,
            cacheKey: `cron_participants_${meeting.meetingId}`,
            cacheTTL: 300,
            enableCache: true,
            retryCount: 3
          }
        );

        const participants = response.data.participants || [];
        
        if (participants.length === 0) {
          console.log(`⚠️ No participants found for meeting ${meeting.topic}`);
        }
        
        for (let participant of participants) {
          // Safely parse dates to avoid "Invalid time value" errors
          const joinTime = participant.join_time ? (() => {
            try {
              const date = new Date(participant.join_time);
              return isNaN(date.getTime()) ? null : date;
            } catch (e) {
              console.warn(`Invalid join_time for participant ${participant.name}: ${participant.join_time}`);
              return null;
            }
          })() : null;
          
          const leaveTime = participant.leave_time ? (() => {
            try {
              const date = new Date(participant.leave_time);
              return isNaN(date.getTime()) ? null : date;
            } catch (e) {
              console.warn(`Invalid leave_time for participant ${participant.name}: ${participant.leave_time}`);
              return null;
            }
          })() : null;

          await meeting.updateParticipant({
            participantId: participant.id,
            name: participant.name,
            email: participant.email,
            joinTime: joinTime,
            leaveTime: leaveTime,
            duration: participant.duration,
            attentiveness: participant.attentiveness_score,
          });
        }

        // Mark report as generated
        meeting.status = 'ended';
        meeting.reportGenerated = true;
        meeting.reportGeneratedAt = new Date();
        await meeting.save();

        console.log(`✅ Processed meeting ${meeting.topic} (${meeting.meetingId}) with ${participants.length} participants`);
        
      } catch (meetingError) {
        console.error(`❌ Failed to process meeting ${meeting.topic}:`, meetingError.message);
        
        // Don't mark as failed if it's a rate limit error - we'll retry next time
        if (meetingError.response?.status !== 429) {
          meeting.reportGenerationFailed = true;
          meeting.reportGenerationError = meetingError.message;
          await meeting.save();
        }
      }
    }
  } catch (reportError) {
    console.error('Error processing Zoom meetings:', reportError.message);
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/stu', StudentRoutes);
app.use('/api/students', StudentRoutes); // Add this for API consistency
app.use('/api/participants', participantsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/zoom', zoomRoutes);
app.use('/api/zoom', zoomEnhancedRoutes); // Mount enhanced routes under same path
app.use('/api/simple-zoom', simpleZoomRoutes);
app.use('/api/realtime', realtimeRoutes);
app.use('/api/meetings', meetingsRoutes);
app.use('/api/attendance-reports', attendanceReportsRoutes);
app.use('/api/attendance-tracker', attendanceTrackerRoutes);
app.use('/api/enhanced-attendance', enhancedAttendanceRoutes); // Enhanced attendance tracking with 85% threshold
app.use('/api/user-sessions', userSessionRoutes);
// Mount webhook routes with a different base path to avoid conflicts
app.use('/api/webhooks', zoomWebhookRoutes);
app.use('/api/zoom', zoomClearRoutes);
app.use('/api/attendance-tracker', zoomDurationAttendanceRoutes); // 85% Zoom duration attendance tracking
app.use('/api/zoom', attendanceTracker85Routes); // 85% Zoom Attendance Duration Tracker

// Initialize System Health Checker
let systemHealthChecker = null;

// Initialize Real-Time Zoom Tracker
let zoomTracker = null;

async function initializeSystemHealthChecker() {
  try {
    console.log('🏥 Initializing System Health Checker...');
    systemHealthChecker = new SystemHealthChecker();
    
    // Make health checker accessible globally
    app.set('systemHealthChecker', systemHealthChecker);
    global.systemHealthChecker = systemHealthChecker;
    
    console.log('✅ System Health Checker initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize System Health Checker:', error);
    console.log('⚠️ Server will continue without system health monitoring');
  }
}

async function initializeZoomTracker() {
  try {
    console.log('🚀 Initializing Real-Time Zoom Tracker...');
    zoomTracker = new RealTimeZoomTracker(io, globalState);
    await zoomTracker.initialize();
    
    // Make tracker accessible globally
    app.set('zoomTracker', zoomTracker);
    
    // Initialize webhook routes with Socket.IO and global state
    initializeWebhookRoutes(io, globalState);
    
    console.log('✅ Real-Time Zoom Tracker initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize Real-Time Zoom Tracker:', error);
    console.log('⚠️ Server will continue without real-time Zoom tracking');
  }
}

// Zoom Tracker status endpoint
app.get('/api/zoom/tracker-status', (req, res) => {
  if (zoomTracker) {
    res.json({
      enabled: true,
      status: zoomTracker.getStatus(),
      timestamp: new Date().toISOString()
    });
  } else {
    res.json({
      enabled: false,
      error: 'Real-time Zoom tracker not initialized',
      timestamp: new Date().toISOString()
    });
  }
});

// Basic health check endpoint
app.get('/api/health', (req, res) => {
  const zoomTrackerStatus = zoomTracker ? zoomTracker.getStatus() : { initialized: false };
  const userSessionStats = userSessionManager ? userSessionManager.getSessionStats() : null;
  
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    activeMeetings: globalState.activeMeetings.size,
    activeParticipants: globalState.activeParticipants.size,
    realTimeTracking: {
      enabled: !!zoomTracker,
      initialized: zoomTrackerStatus.initialized,
      activeMeetingsTracked: zoomTrackerStatus.activeMeetings?.length || 0
    },
    socketIO: {
      connected: io.engine.clientsCount,
      transports: ['websocket', 'polling']
    },
    userSessions: userSessionStats,
    rateLimiter: rateLimiter.getStats(),
    requestQueue: zoomRequestQueue.getStats()
  });
});

// Comprehensive health check endpoint
app.get('/api/health/detailed', async (req, res) => {
  try {
    if (systemHealthChecker) {
      const healthStatus = systemHealthChecker.getHealthStatus();
      res.json({
        success: true,
        ...healthStatus,
        userSessions: userSessionManager ? userSessionManager.getSessionStats() : null
      });
    } else {
      res.json({
        success: false,
        message: 'System health checker not initialized',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// User session system validation endpoint
app.get('/api/health/validate-user-sessions', async (req, res) => {
  try {
    if (systemHealthChecker) {
      const validation = await systemHealthChecker.validateUserSessionSystem();
      res.json(validation);
    } else {
      res.json({
        timestamp: new Date(),
        summary: {
          overallStatus: 'error',
          validationScore: 0,
          passedChecks: 0,
          totalChecks: 1
        },
        results: [{
          check: 'System Health Checker',
          status: 'failed',
          message: 'System health checker not initialized'
        }]
      });
    }
  } catch (error) {
    res.status(500).json({
      timestamp: new Date(),
      summary: {
        overallStatus: 'error',
        validationScore: 0,
        error: error.message
      },
      results: [{
        check: 'Validation Execution',
        status: 'error',
        message: error.message
      }]
    });
  }
});

// Rate limiter statistics endpoint
app.get('/api/rate-limiter/stats', (req, res) => {
  try {
    const stats = rateLimiter.getStats();
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Request queue statistics endpoint
app.get('/api/request-queue/stats', (req, res) => {
  try {
    const stats = zoomRequestQueue.getStats();
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Request queue control endpoints
app.post('/api/request-queue/clear', (req, res) => {
  try {
    zoomRequestQueue.clear();
    res.json({
      success: true,
      message: 'Request queue cleared',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Rate limiter control endpoints
app.post('/api/rate-limiter/reset-stats', (req, res) => {
  try {
    rateLimiter.resetStats();
    res.json({
      success: true,
      message: 'Rate limiter statistics reset',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/rate-limiter/clear-cache', (req, res) => {
  try {
    rateLimiter.clearCaches();
    res.json({
      success: true,
      message: 'Rate limiter caches cleared',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Socket.IO test endpoint
app.get('/api/socketio-test', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Socket.IO Test</title>
      <script src="https://cdn.socket.io/4.7.4/socket.io.min.js"></script>
    </head>
    <body>
      <h1>Socket.IO Connection Test</h1>
      <div id="status">Connecting...</div>
      <div id="messages"></div>
      
      <script>
        const socket = io('http://localhost:5000', {
          transports: ['websocket', 'polling'],
          timeout: 5000
        });
        
        const statusDiv = document.getElementById('status');
        const messagesDiv = document.getElementById('messages');
        
        function addMessage(msg) {
          const p = document.createElement('p');
          p.textContent = new Date().toLocaleTimeString() + ': ' + msg;
          messagesDiv.appendChild(p);
        }
        
        socket.on('connect', () => {
          statusDiv.innerHTML = '✅ Connected to Socket.IO server!';
          statusDiv.style.color = 'green';
          addMessage('Connected with ID: ' + socket.id);
        });
        
        socket.on('disconnect', () => {
          statusDiv.innerHTML = '❌ Disconnected from Socket.IO server';
          statusDiv.style.color = 'red';
          addMessage('Disconnected');
        });
        
        socket.on('connect_error', (error) => {
          statusDiv.innerHTML = '❌ Connection Error: ' + error.message;
          statusDiv.style.color = 'red';
          addMessage('Connection error: ' + error.message);
        });
        
        socket.on('initialState', (data) => {
          addMessage('Received initial state with ' + data.activeMeetings.length + ' meetings');
        });
      </script>
    </body>
    </html>
  `);
});

// Export globalState for use in routes
module.exports = { globalState };

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Socket.IO enabled for real-time communication`);
  console.log(`🌐 CORS enabled for: ${process.env.FRONTEND_URL}`);
  
  // Initialize services after server starts
  await initializeZoomTracker();
  await initializeSystemHealthChecker();
  
  // Start periodic health checks if system health checker is initialized
  if (systemHealthChecker) {
    console.log('🔄 Starting periodic health checks (every 60 seconds)');
    systemHealthChecker.startPeriodicChecks(60000); // 60 seconds
  }
});

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
  console.log('🔄 Received SIGTERM signal. Graceful shutdown...');
  server.close(async () => {
    console.log('🔚 HTTP server closed.');
    try {
      await mongoose.connection.close();
      console.log('🔒 MongoDB connection closed.');
    } catch (error) {
      console.error('❌ Error closing MongoDB connection:', error.message);
    }
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('🔄 Received SIGINT signal. Graceful shutdown...');
  server.close(async () => {
    console.log('🔚 HTTP server closed.');
    try {
      await mongoose.connection.close();
      console.log('🔒 MongoDB connection closed.');
    } catch (error) {
      console.error('❌ Error closing MongoDB connection:', error.message);
    }
    process.exit(0);
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception thrown:', error);
  process.exit(1);
});

console.log('🛡️ Process handlers registered for graceful shutdown');
