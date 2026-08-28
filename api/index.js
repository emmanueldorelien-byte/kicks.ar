require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const globalForPrisma = global;
const prisma = globalForPrisma.prisma || new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  log: ['error', 'warn'],
});
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.all('/api', (req, res) => {
  res.json({ status: 'ok', message: 'API KICKS funcionando en Vercel' });
});

app.get('/api/test-db', async (req, res) => {
  try {
    const count = await prisma.product.count();
    res.json({ success: true, message: 'Conexión exitosa a la BD', totalProductos: count });
  } catch (error) {
    console.error('ERROR PRISMA VERCEL:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
      meta: error.meta
    });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { isAvailable: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(Array.isArray(products) ? products : []);
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(200).json([]);
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const cleanEmail = email.toLowerCase().trim();

    const existingUser = await prisma.user.findUnique({
      where: { email: cleanEmail }
    }).catch(err => {
      console.error('❌ Error de conexión con Supabase en Prisma:', err.message);
      throw new Error('Fallo al conectar con la base de datos.');
    });

    if (existingUser) return res.status(400).json({ error: 'El email ya se encuentra registrado' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email: cleanEmail,
        password: hashedPassword,
        role: 'CLIENT'
      }
    });

    res.json({ success: true, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    console.error('Error detallado en /api/auth/register:', error);
    res.status(500).json({ error: error.message || 'Error en el servidor al registrarse' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const cleanEmail = email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } });

    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Credenciales inválidas' });

    res.json({ success: true, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: error.message || 'Error en el servidor al iniciar sesión' });
  }
});

app.get('/api/users/:id/orders', async (req, res) => {
  try {
    const { id } = req.params;
    const orders = await prisma.order.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' }
    });
    res.json(orders);
  } catch (error) {
    console.error('Error al obtener compras del usuario:', error);
    res.status(500).json({ error: 'Error al obtener historial de compras' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(orders);
  } catch (error) {
    console.error('Error al obtener órdenes:', error);
    res.status(500).json({ error: 'Error al obtener las órdenes' });
  }
});

app.get('/api/orders/metrics', async (req, res) => {
  try {
    const { filter } = req.query;
    const now = new Date();
    let dateFilter = {};

    if (filter === 'today') {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      dateFilter = { createdAt: { gte: startOfDay } };
    } else if (filter === 'month') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFilter = { createdAt: { gte: startOfMonth } };
    }

    const validOrders = await prisma.order.findMany({
      where: {
        status: { in: ['APPROVED', 'SHIPPED', 'DELIVERED'] },
        ...dateFilter
      }
    });

    let totalRevenue = 0;
    validOrders.forEach(order => {
      totalRevenue += Number(order.totalAmount || 0);
    });

    res.json({
      totalRevenue,
      totalOrders: validOrders.length
    });
  } catch (error) {
    console.error('Error al calcular métricas:', error);
    res.status(500).json({ error: 'Error al calcular métricas' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado', path: req.url, method: req.method });
});

module.exports = (req, res) => {
  if (!req.url.startsWith('/api')) {
    req.url = '/api' + req.url;
  }
  return app(req, res);
};
