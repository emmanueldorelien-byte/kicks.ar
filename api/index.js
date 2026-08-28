const express = require('express');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

app.use(express.json());

// Endpoint de prueba de conexión
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
    const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos', details: error.message });
  }
});

module.exports = app;