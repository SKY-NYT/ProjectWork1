const jwt = require('jsonwebtoken');
const User = require('../models/User');
const TokenDebugger = require('../utils/tokenDebugger');

const auth = async (req, res, next) => {
  try {
    // Check for token either in cookies or Authorization header (Bearer token)
    const token = req.cookies?.authToken || req.header('Authorization')?.replace('Bearer ', '');

    console.log('🔍 AUTH MIDDLEWARE DEBUG:');
    console.log('Request URL:', req.originalUrl);
    console.log('Cookies authToken present:', !!req.cookies?.authToken);
    console.log('Authorization header present:', !!req.header('Authorization'));
    console.log('Final token present:', !!token);
    console.log('Token type:', typeof token);
    if (token) {
      console.log('Token length:', token.length);
      console.log('Token starts with Bearer:', token.startsWith('Bearer '));
      console.log('First 20 chars:', token.substring(0, 20) + '...');
    }

    if (!token) {
      console.log('❌ No token found in request');
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    // Enhanced token debugging
    const debugInfo = await TokenDebugger.debugToken(token);
    TokenDebugger.logDebugInfo(debugInfo);

    try {
      // Verify token with JWT secret key
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      console.log('✅ Token verification successful');
      console.log('🔍 Decoded token details:', {
        userId: decoded.userId,
        username: decoded.username,
        email: decoded.email,
        role: decoded.role,
        iat: decoded.iat ? new Date(decoded.iat * 1000).toISOString() : 'missing',
        exp: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : 'missing',
        isExpired: decoded.exp ? Date.now() >= decoded.exp * 1000 : 'unknown'
      });

      // Find user in database by decoded userId
      console.log('🔍 Looking up user in database with ID:', decoded.userId);
      const user = await User.findById(decoded.userId);

      if (!user) {
        console.log('❌ User not found for token userId:', decoded.userId);
        return res.status(401).json({
          success: false,
          message: 'User not found',
        });
      }

      console.log('✅ User found in database:', {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin
      });

      // Ensure user role matches role encoded in token
      console.log('🔍 Checking role consistency:');
      console.log('Token role:', decoded.role);
      console.log('User role:', user.role);
      console.log('Roles match:', user.role === decoded.role);
      
      if (user.role !== decoded.role) {
        console.log('❌ ROLE MISMATCH DETECTED:', {
          tokenRole: decoded.role,
          userRole: user.role,
        });
        return res.status(401).json({
          success: false,
          message: 'Invalid token',
        });
      }

      // Attach user and token to request object for downstream use
      req.user = user;
      req.token = token;

      console.log('✅ Authentication successful for user:', user.username);
      console.log('🔐 ===== AUTH MIDDLEWARE COMPLETE =====\n');

      // Proceed to next middleware or route handler
      next();
    } catch (jwtError) {
      console.error('❌ JWT verification error:', {
        name: jwtError.name,
        message: jwtError.message,
        tokenLength: token ? token.length : 0,
        jwtSecretExists: !!process.env.JWT_SECRET
      });
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
      });
    }
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(401).json({
      success: false,
      message: 'Authentication failed',
    });
  }
};

// Middleware factory to check if user's role is allowed
const checkRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      console.log('No user attached to request');
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      console.log('Access denied. User role not authorized:', {
        userRole: req.user.role,
        allowedRoles,
      });
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    // User role authorized, proceed
    next();
  };
};

module.exports = { auth, checkRole };
