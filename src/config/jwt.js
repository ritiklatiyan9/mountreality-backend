import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

// Access tokens are deliberately short lived. Refresh tokens are session-bound
// and rotated by the refresh endpoint, so a copied token cannot be replayed for
// weeks after its legitimate session logs out.
export const signAccessToken = (payload) => jwt.sign(payload, ACCESS_SECRET, {
	expiresIn: process.env.JWT_ACCESS_TTL || '15m',
});
export const signRefreshToken = (payload) => jwt.sign(payload, REFRESH_SECRET, {
	expiresIn: process.env.JWT_REFRESH_TTL || '7d',
});
export const verifyToken = (token, secret = ACCESS_SECRET) => jwt.verify(token, secret);
export const hashPassword = async (password) => await bcrypt.hash(password, 10);
export const comparePassword = async (password, hash) => {
	if (!password || !hash || typeof password !== 'string' || typeof hash !== 'string') {
		return false;
	}
	return bcrypt.compare(password, hash);
};
export const hashRefreshToken = async (token) => await bcrypt.hash(token, 10);
