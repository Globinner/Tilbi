const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { dbHelpers } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || 'never';
const SIGN_IN_AGAIN = 'Please sign in again.';

function generateToken(userId) {
  const payload = { userId };
  const expiry = String(JWT_EXPIRY || '').trim();
  if (!expiry || expiry === '0' || /^(never|none|false)$/i.test(expiry)) {
    return jwt.sign(payload, JWT_SECRET);
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiry });
}

function verifyToken(token) {
  try {
    // Always accept previously issued Tilbi sessions, including old 30-day JWTs.
    return jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
  } catch (error) {
    return null;
  }
}

function attachRefreshedToken(res, userId) {
  const fresh = generateToken(userId);
  res.setHeader('X-New-Token', fresh);
  if (res._tilbiTokenWrapped) return fresh;
  res._tilbiTokenWrapped = true;
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400 && body && typeof body === 'object' && !Array.isArray(body) && !body.token) {
      body.token = fresh;
    }
    return origJson(body);
  };
  return fresh;
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
    return res.status(401).json({ error: SIGN_IN_AGAIN });
  }

  const decoded = verifyToken(token);
  if (!decoded || decoded.userId == null) {
    return res.status(403).json({ error: SIGN_IN_AGAIN });
  }

  req.userId = decoded.userId;
  attachRefreshedToken(res, decoded.userId);
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




