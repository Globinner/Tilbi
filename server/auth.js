const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { dbHelpers } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRY = '30d';

// Generate JWT token
function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

// Verify JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Hash password
async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

// Compare password
async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  req.userId = decoded.userId;
  next();
}

// Register new user
async function registerUser(email, password) {
  try {
    // Check if user exists
    const existingUser = await dbHelpers.getUserByEmail(email);
    if (existingUser) {
      throw new Error('User already exists');
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const user = await dbHelpers.createUser(email, passwordHash);

    // Generate token
    const token = generateToken(user.id);

    return { user: { id: user.id, email: user.email }, token };
  } catch (error) {
    throw error;
  }
}

// Login user
async function loginUser(email, password) {
  try {
    // Get user
    const user = await dbHelpers.getUserByEmail(email);
    if (!user) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const isValid = await comparePassword(password, user.password_hash);
    if (!isValid) {
      throw new Error('Invalid credentials');
    }

    // Generate token
    const token = generateToken(user.id);

    return { user: { id: user.id, email: user.email }, token };
  } catch (error) {
    throw error;
  }
}

module.exports = {
  generateToken,
  verifyToken,
  hashPassword,
  comparePassword,
  authenticateToken,
  registerUser,
  loginUser
};




