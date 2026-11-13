import mysql, { Pool, PoolConnection } from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

/**
 * High-performance MariaDB/MySQL Connection Pool configured for
 * FreeRADIUS 3.x (`radius` schema) high-concurrency accounting and batch writes.
 */
export const dbPool: Pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'radius',
  password: process.env.DB_PASSWORD || 'radpass',
  database: process.env.DB_NAME || 'radius',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT) || 25,
  maxIdle: 10,
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: 'Z',
  decimalNumbers: true,
  multipleStatements: false, // Disabled to prevent SQL injection vectors
});

/**
 * Executes a callback inside an ACID database transaction with automatic
 * commit/rollback and connection release.
 */
export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  const connection = await dbPool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
