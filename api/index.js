// api/index.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');

// Reutilización de instancia global para Serverless
const globalForPrisma = global;
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

const app = express();
app.use(express.json());

app.get('/api/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { isAvailable: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(products);
  } catch (error) {
    console.error('Error Prisma Serverless:', error);
    res.status(500).json({ error: 'Error al conectar con la base de datos', details: error.message });
  }
});

module.exports = app;