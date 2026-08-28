const express = require('express');
const { PrismaClient } = require('@prisma/client');

// Reutilización global del cliente para evitar agotar las conexiones en Vercel
const globalForPrisma = global;
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

const app = express();
app.use(express.json());

// Endpoint de diagnóstico
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

// Endpoint principal del catálogo
app.get('/api/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({ 
      where: { isAvailable: true },
      orderBy: { createdAt: 'desc' } 
    });
    res.json(Array.isArray(products) ? products : []);
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(500).json({ error: 'Error al obtener productos', details: error.message });
  }
});

module.exports = app;