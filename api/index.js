require('dotenv').config();

const { URL } = require('url');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');

const IS_VERCEL = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
try {
  const directUrl = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  if (directUrl) {
    const u = new URL(directUrl);
    if (!IS_VERCEL) {
      u.hostname = 'aws-0-us-west-2.pooler.supabase.com';
      u.port = '5432';
    }
    if (!u.searchParams.has('sslmode')) u.searchParams.set('sslmode', 'require');
    if (!u.searchParams.has('pgbouncer')) u.searchParams.set('pgbouncer', 'true');
    u.searchParams.set('connection_limit', String(IS_VERCEL ? '1' : '5'));
    const finalUrl = u.toString();
    process.env.DATABASE_URL = finalUrl;
    process.env.DIRECT_URL = finalUrl;
  }
} catch (e) {
  console.warn('No se pudo ajustar URL de BD:', e.message);
}

const express = require('express');

const globalForPrisma = global;
const prisma = globalForPrisma.prisma || new PrismaClient({
  log: ['error', 'warn'],
});
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

const DOWN_PAYMENT_PERCENTAGE = 0.20;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (e) {
  console.warn('No se pudo crear directorio uploads:', e.message);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, 'media-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

async function safeSendWhatsApp(phone, message) {
  console.warn(`[WhatsApp - No disponible en Vercel] Mensaje para ${phone}: ${message.slice(0, 80)}...`);
  return null;
}

function parseImagesInput(imagesField, imageUrlField) {
  let list = [];
  if (Array.isArray(imagesField)) {
    list = imagesField.map(img => String(img).trim()).filter(Boolean);
  } else if (typeof imagesField === 'string') {
    list = imagesField.split(',').map(img => img.trim()).filter(Boolean);
  }

  if (imageUrlField && typeof imageUrlField === 'string' && imageUrlField.trim().length > 0) {
    const singleUrl = imageUrlField.trim();
    if (!list.includes(singleUrl)) {
      list.unshift(singleUrl);
    }
  }

  return list;
}

function generateOrderPDFBuffer(order) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      let buffers = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const totalAmount = Number(order.totalAmount || 0);
      const isEfectivoConSena = order.payment && order.payment.includes('Efectivo');
      const formattedTotal = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(totalAmount);

      doc.rect(0, 0, 595.28, 12).fill('#0F172A');
      doc.fillColor('#0F172A').fontSize(24).font('Helvetica-Bold').text('KICKS', 40, 35);
      doc.fillColor('#64748B').fontSize(10).font('Helvetica').text('COMPROBANTE DE PEDIDO', 40, 62);

      doc.fillColor('#0F172A').fontSize(12).font('Helvetica-Bold').text(`ORDEN #${order.id.slice(0, 8).toUpperCase()}`, 350, 38, { align: 'right' });
      doc.fillColor('#64748B').fontSize(9).font('Helvetica').text(`Fecha: ${new Date(order.createdAt).toLocaleString('es-AR')}`, 350, 56, { align: 'right' });

      doc.moveTo(40, 80).lineTo(555, 80).strokeColor('#E2E8F0').lineWidth(1).stroke();

      let badgeBg = '#FEF3C7';
      let badgeColor = '#D97706';
      let statusText = 'PAGO EN PROCESO DE REVISIÓN';

      if (order.status === 'APPROVED') {
        badgeBg = '#DCFCE7';
        badgeColor = '#15803D';
        statusText = 'PAGO CONFIRMADO Y APROBADO';
      } else if (order.status === 'REJECTED') {
        badgeBg = '#FEE2E2';
        badgeColor = '#B91C1C';
        statusText = 'PAGO RECHAZADO';
      }

      doc.roundedRect(40, 95, 515, 28, 6).fill(badgeBg);
      doc.fillColor(badgeColor).fontSize(10).font('Helvetica-Bold').text(statusText, 40, 104, { align: 'center' });

      let startY = 140;
      doc.fillColor('#0F172A').fontSize(12).font('Helvetica-Bold').text('Detalle de Ítems', 40, startY);
      startY += 18;

      doc.rect(40, startY, 515, 22).fill('#F1F5F9');
      doc.fillColor('#475569').fontSize(9).font('Helvetica-Bold');
      doc.text('ÍTEM / DESCRIPCIÓN', 50, startY + 6);
      doc.text('TALLE', 300, startY + 6);
      doc.text('COLOR', 370, startY + 6);
      doc.text('SUBTOTAL', 470, startY + 6, { align: 'right' });

      startY += 22;

      const items = JSON.parse(order.itemsSummary || '[]');
      doc.font('Helvetica').fontSize(9);

      items.forEach((item, index) => {
        const itemPrice = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(item.price);

        if (index % 2 === 0) {
          doc.rect(40, startY, 515, 22).fill('#FAFAFA');
        }

        doc.fillColor('#1E293B');
        doc.text(`${index + 1}. ${item.name}`, 50, startY + 6, { width: 240, ellipsis: true });
        doc.text(`${item.size || 'N/A'}`, 300, startY + 6);
        doc.text(`${item.color || 'N/A'}`, 370, startY + 6);
        doc.text(`${itemPrice}`, 440, startY + 6, { width: 105, align: 'right' });

        startY += 22;
      });

      doc.moveTo(40, startY + 2).lineTo(555, startY + 2).strokeColor('#CBD5E1').lineWidth(0.8).stroke();
      startY += 12;

      doc.rect(330, startY, 225, isEfectivoConSena ? 75 : 42).fill('#F8FAFC').strokeColor('#E2E8F0').lineWidth(1).stroke();

      doc.fillColor('#475569').fontSize(10).font('Helvetica-Bold').text('Total del Pedido:', 340, startY + 12);
      doc.fillColor('#0F172A').fontSize(12).font('Helvetica-Bold').text(`${formattedTotal}`, 430, startY + 11, { align: 'right' });

      if (isEfectivoConSena) {
        const depositAmount = totalAmount * DOWN_PAYMENT_PERCENTAGE;
        const remainingAmount = totalAmount - depositAmount;

        const formattedDeposit = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(depositAmount);
        const formattedRemaining = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(remainingAmount);

        doc.fillColor('#2563EB').fontSize(9).font('Helvetica').text(`• Seña Abonada (20%): ${formattedDeposit}`, 340, startY + 32);
        doc.fillColor('#DC2626').fontSize(9).font('Helvetica-Bold').text(`• Resto en Efectivo: ${formattedRemaining}`, 340, startY + 50);
      }

      startY += isEfectivoConSena ? 90 : 55;

      const boxWidth = 250;
      const boxHeight = 110;

      doc.roundedRect(40, startY, boxWidth, boxHeight, 6).fill('#F8FAFC').strokeColor('#E2E8F0').lineWidth(1).stroke();
      doc.fillColor('#0F172A').fontSize(10).font('Helvetica-Bold').text('📦 Datos de Entrega', 52, startY + 12);

      doc.fillColor('#475569').fontSize(8.5).font('Helvetica');
      doc.text(`Destinatario: `, 52, startY + 30, { continued: true }).fillColor('#0F172A').font('Helvetica-Bold').text(`${order.recipientName || 'N/A'}`);
      doc.fillColor('#475569').font('Helvetica').text(`Dirección: `, 52, startY + 45, { continued: true }).fillColor('#0F172A').font('Helvetica-Bold').text(`${order.address}`);
      doc.fillColor('#475569').font('Helvetica').text(`Modalidad: `, 52, startY + 60, { continued: true }).fillColor('#0F172A').font('Helvetica-Bold').text(`${order.deliveryOption || 'N/A'}`);
      doc.fillColor('#475569').font('Helvetica').text(`Día/Horario: `, 52, startY + 75, { continued: true }).fillColor('#0F172A').font('Helvetica-Bold').text(`${order.deliveryDay || ''} ${order.deliveryTimeSlot || ''}`);

      doc.roundedRect(305, startY, boxWidth, boxHeight, 6).fill('#F8FAFC').strokeColor('#E2E8F0').lineWidth(1).stroke();
      doc.fillColor('#0F172A').fontSize(10).font('Helvetica-Bold').text('💳 Medio de Pago', 317, startY + 12);

      doc.fillColor('#475569').fontSize(8.5).font('Helvetica');
      doc.text(`Método Seleccionado:`, 317, startY + 30);
      doc.fillColor('#2563EB').fontSize(10).font('Helvetica-Bold').text(`${order.payment}`, 317, startY + 44);

      doc.fillColor('#94A3B8').fontSize(8).font('Helvetica').text(
        'Gracias por elegir KICKS. Ante cualquier duda o reclamo, comunícate a soportekicks@gmail.com',
        40, 770, { align: 'center', width: 515 }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

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

app.post('/api/upload-images', upload.array('localImages', 5), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se recibieron archivos.' });
    }
    const uploadedUrls = req.files.map(file => `/uploads/${file.filename}`);
    res.json({ success: true, urls: uploadedUrls });
  } catch (error) {
    console.error('Error al subir archivos:', error);
    res.status(500).json({ error: 'Error interno al procesar archivos.' });
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

app.post('/api/products', async (req, res) => {
  try {
    const {
      name, price, category, sizes, colors, stock, imageUrl, images,
      videoUrl, description, shippingMinutes, promoType, discountPercent,
      isHotSale, isBlackFriday, isFeatured, isAvailable
    } = req.body;

    let parsedSizes = Array.isArray(sizes)
      ? sizes.map(s => String(s).trim()).filter(Boolean)
      : (typeof sizes === 'string' ? sizes.split(',').map(s => s.trim()).filter(Boolean) : []);

    let parsedColors = Array.isArray(colors)
      ? colors.map(c => String(c).trim()).filter(Boolean)
      : (typeof colors === 'string' ? colors.split(',').map(c => c.trim()).filter(Boolean) : []);

    let parsedImages = parseImagesInput(images, imageUrl);

    const newProduct = await prisma.product.create({
      data: {
        name: String(name).trim(),
        price: parseFloat(price) || 0,
        category: category ? String(category).trim() : 'CALZADOS_IMPORTADOS',
        sizes: parsedSizes,
        colors: parsedColors,
        stock: parseInt(stock, 10) || 0,
        imageUrl: parsedImages[0] || null,
        images: parsedImages,
        videoUrl: videoUrl ? String(videoUrl).trim() : null,
        description: description ? String(description).trim() : null,
        shippingMinutes: parseInt(shippingMinutes, 10) || 60,
        promoType: promoType || 'NONE',
        discountPercent: parseInt(discountPercent, 10) || 0,
        isHotSale: Boolean(isHotSale),
        isBlackFriday: Boolean(isBlackFriday),
        isFeatured: Boolean(isFeatured),
        isAvailable: isAvailable !== undefined ? Boolean(isAvailable) : true
      }
    });

    res.json({ success: true, product: newProduct });
  } catch (error) {
    console.error('Error al crear producto:', error);
    res.status(500).json({ error: 'Error al crear el producto' });
  }
});

app.put('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const {
      name, price, category, sizes, colors, stock, imageUrl, images,
      videoUrl, description, shippingMinutes, promoType, discountPercent,
      isHotSale, isBlackFriday, isFeatured, isAvailable
    } = req.body;

    let parsedSizes;
    if (sizes !== undefined) {
      parsedSizes = Array.isArray(sizes)
        ? sizes.map(s => String(s).trim()).filter(Boolean)
        : (typeof sizes === 'string' ? sizes.split(',').map(s => s.trim()).filter(Boolean) : []);
    }

    let parsedColors;
    if (colors !== undefined) {
      parsedColors = Array.isArray(colors)
        ? colors.map(c => String(c).trim()).filter(Boolean)
        : (typeof colors === 'string' ? colors.split(',').map(c => c.trim()).filter(Boolean) : []);
    }

    let parsedImages;
    if (images !== undefined || imageUrl !== undefined) {
      parsedImages = parseImagesInput(images, imageUrl);
    }

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        ...(name && { name: String(name).trim() }),
        price: parseFloat(price) || 0,
        ...(category && { category: String(category).trim() }),
        ...(parsedSizes && { sizes: parsedSizes }),
        ...(parsedColors && { colors: parsedColors }),
        stock: parseInt(stock, 10) || 0,
        ...(parsedImages && { images: parsedImages, imageUrl: parsedImages[0] || null }),
        videoUrl: videoUrl !== undefined ? (videoUrl ? String(videoUrl).trim() : null) : undefined,
        description: description !== undefined ? (description ? String(description).trim() : null) : undefined,
        shippingMinutes: parseInt(shippingMinutes, 10) || 60,
        promoType: promoType || 'NONE',
        discountPercent: parseInt(discountPercent, 10) || 0,
        isHotSale: Boolean(isHotSale),
        isBlackFriday: Boolean(isBlackFriday),
        isFeatured: Boolean(isFeatured),
        isAvailable: isAvailable !== undefined ? Boolean(isAvailable) : true
      }
    });

    res.json({ success: true, product: updatedProduct });
  } catch (error) {
    console.error('Error al actualizar producto:', error);
    res.status(500).json({ error: 'Error al actualizar el producto' });
  }
});

app.patch('/api/products/:id/toggle-availability', async (req, res) => {
  const { id } = req.params;
  try {
    const currentProduct = await prisma.product.findUnique({ where: { id } });
    if (!currentProduct) return res.status(404).json({ error: 'Producto no encontrado' });

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: { isAvailable: !currentProduct.isAvailable }
    });

    res.json({ success: true, isAvailable: updatedProduct.isAvailable });
  } catch (error) {
    console.error('Error al cambiar disponibilidad:', error);
    res.status(500).json({ error: 'Error al cambiar la disponibilidad' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.product.delete({ where: { id } });
    res.json({ success: true, message: 'Producto eliminado correctamente.' });
  } catch (error) {
    console.error('Error al eliminar producto:', error);
    res.status(500).json({ error: 'Error al eliminar el producto.' });
  }
});

app.post('/api/products/import-excel', upload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo Excel.' });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    let createdCount = 0;

    for (const row of rows) {
      if (!row.name || !row.price) continue;

      const sizes = row.sizes ? String(row.sizes).split(',').map(s => s.trim()).filter(Boolean) : [];
      const colors = row.colors ? String(row.colors).split(',').map(c => c.trim()).filter(Boolean) : [];
      const images = row.imageUrl ? [String(row.imageUrl).trim()] : [];

      await prisma.product.create({
        data: {
          name: String(row.name).trim(),
          price: parseFloat(row.price) || 0,
          category: row.category ? String(row.category).trim() : 'CALZADOS_IMPORTADOS',
          sizes: sizes,
          colors: colors,
          stock: parseInt(row.stock, 10) || 0,
          imageUrl: images[0] || null,
          images: images,
          description: row.description ? String(row.description).trim() : null,
          isAvailable: row.isAvailable !== undefined ? Boolean(row.isAvailable) : true
        }
      });
      createdCount++;
    }

    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (e) {
      console.warn('No se pudo borrar archivo Excel temporal:', e.message);
    }

    res.json({ success: true, message: `Se importaron ${createdCount} productos con éxito.` });
  } catch (error) {
    console.error('Error procesando Excel:', error);
    res.status(500).json({ error: 'Error al procesar la plantilla de Excel.' });
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

app.get('/api/orders/:id/pdf', async (req, res) => {
  try {
    const { id } = req.params;
    const order = await prisma.order.findUnique({ where: { id } });

    if (!order) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const pdfBuffer = await generateOrderPDFBuffer(order);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Resumen_Orden_${order.id.slice(0, 8)}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error al generar PDF de la orden:', error);
    res.status(500).json({ error: 'Error al generar el PDF de la orden' });
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

app.post('/api/orders/approve', async (req, res) => {
  const { orderId } = req.body;
  try {
    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status: 'APPROVED' }
    });

    const mensajeAprobado =
      `🎉 *¡PAGO APROBADO Y CONFIRMADO!*\n\n` +
      `Hola! Te confirmamos que tu pago para la Orden *#${order.id.slice(0, 8)}* ha sido validado con éxito.\n\n` +
      `📦 *Estado:* Su pedido ya se encuentra en preparación para el despacho.\n` +
      `Te adjuntamos a continuación tu *comprobante de pago actualizado* en formato PDF. ¡Muchas gracias por tu compra!\n\n` +
      `📩 Soporte: relaxmy89@gmail.com`;

    await safeSendWhatsApp(order.phone, mensajeAprobado);

    try {
      const pdfBuffer = await generateOrderPDFBuffer(order);
      console.log(`PDF generado para orden ${orderId} (${pdfBuffer.length} bytes) - No enviado por WhatsApp en Vercel`);
    } catch (pdfErr) {
      console.error('Error generando PDF aprobado:', pdfErr);
    }

    res.json({ success: true, message: 'Pago aprobado en BD. WhatsApp no disponible en entorno serverless.', order });
  } catch (error) {
    console.error('Error al aprobar la orden:', error);
    res.status(500).json({ error: 'Error al aprobar la orden' });
  }
});

app.post('/api/orders/reject', async (req, res) => {
  const { orderId, reason } = req.body;
  try {
    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status: 'REJECTED' }
    });

    const mensajeRechazado =
      `⚠️ *NOVEDAD SOBRE SU PAGO*\n\n` +
      `Hola. Lamentablemente no pudimos validar el comprobante para la Orden *#${order.id.slice(0, 8)}*.\n` +
      `Motivo: ${reason || 'Comprobante ilegible o pago no acreditado'}.\n\n` +
      `📩 Para recibir asistencia o realizar reclamos, comunícate por mail a: *soportekicks@gmail.com*`;

    await safeSendWhatsApp(order.phone, mensajeRechazado);
    res.json({ success: true, message: 'Pago denegado en BD. WhatsApp no disponible en entorno serverless.', order });
  } catch (error) {
    console.error('Error al rechazar la orden:', error);
    res.status(500).json({ error: 'Error al rechazar la orden' });
  }
});

app.post('/api/orders/update-status', async (req, res) => {
  const { orderId, status, customMessage } = req.body;
  try {
    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status }
    });

    let mensajeWhatsApp = '';

    switch (status) {
      case 'SHIPPED':
        mensajeWhatsApp = `🚚 *¡TU PEDIDO FUE ENVIADO!*\n\nHola! Te notificamos que tu Orden *#${order.id.slice(0, 8)}* ya se encuentra en camino a la dirección registrada (${order.address}).\n\n📩 Para recibir asistencia o realizar reclamos, comunícate por mail a: *soportekicks@gmail.com*`;
        break;
      case 'RESCHEDULED':
        mensajeWhatsApp = `📅 *ENTREGA REPROGRAMADA*\n\nHola. Te informamos que la entrega de tu Orden *#${order.id.slice(0, 8)}* ha sido reprogramada.\n${customMessage ? `Detalle: ${customMessage}\n` : ''}Nos pondremos en contacto a la brevedad.\n\n📩 Para recibir asistencia o realizar reclamos, comunícate por mail a: *soportekicks@gmail.com*`;
        break;
      case 'DELIVERED':
        mensajeWhatsApp = `🎉 *¡PEDIDO ENTREGADO!*\n\nTu Orden *#${order.id.slice(0, 8)}* figura como entregada con éxito. ¡Esperamos que disfrutes tu compra!\n\n📩 Para recibir asistencia o realizar reclamos, comunícate por mail a: *soportekicks@gmail.com*`;
        break;
      case 'CANCELLED':
        mensajeWhatsApp = `❌ *PEDIDO CANCELADO*\n\nHola. Tu Orden *#${order.id.slice(0, 8)}* ha sido cancelada.\n${customMessage ? `Motivo: ${customMessage}\n` : ''}\n📩 Para recibir asistencia o realizar reclamos, comunícate por mail a: *soportekicks@gmail.com*`;
        break;
      default:
        mensajeWhatsApp = `📌 Tu Orden *#${order.id.slice(0, 8)}* ha cambiado al estado: ${status}.\n\n📩 Para recibir asistencia o realizar reclamos, comunícate por mail a: *soportekicks@gmail.com*`;
    }

    await safeSendWhatsApp(order.phone, mensajeWhatsApp);
    res.json({ success: true, message: `Estado actualizado a ${status} en BD. WhatsApp no disponible en serverless.`, order });
  } catch (error) {
    console.error('Error al actualizar estado:', error);
    res.status(500).json({ error: 'Error al actualizar el estado de la orden' });
  }
});

app.get('/api/returns', async (req, res) => {
  try {
    const returns = await prisma.returnRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: { order: true }
    });
    res.json(returns);
  } catch (error) {
    console.error('Error al obtener solicitudes de devolución:', error);
    res.status(500).json({ error: 'Error al obtener solicitudes de devolución' });
  }
});

app.post('/api/returns/approve', async (req, res) => {
  const { requestId, shippingCost } = req.body;
  try {
    const config = await prisma.paymentConfig.findFirst().catch(() => null);
    const finalCost = shippingCost !== undefined ? parseFloat(shippingCost) : (config?.returnShippingCost || 3500);

    const returnReq = await prisma.returnRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED_AWAITING_PAYMENT',
        shippingCost: finalCost
      }
    });

    const formattedCost = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(finalCost);

    const mensajeAprobado =
      `✅ *SOLICITUD DE ${returnReq.type} APROBADA*\n\n` +
      `Tu solicitud para la Orden *#${returnReq.orderId.slice(0, 8)}* ha sido aprobada con éxito.\n\n` +
      `📦 *Costo de envío para la gestión:* *${formattedCost}*\n\n` +
      `🏦 *Datos para abonar la gestión del envío:*\n` +
      `Alias/CBU: *${config?.bankAlias || 'Consultar CBU por privado'}*\n\n` +
      `Por favor, cuando realices la transferencia responde únicamente enviando la *foto o comprobante del pago* por este medio.`;

    await safeSendWhatsApp(returnReq.phone, mensajeAprobado);

    res.json({ success: true, message: 'Solicitud aprobada en BD. WhatsApp no disponible en serverless.', returnReq });
  } catch (error) {
    console.error('Error al aprobar solicitud:', error);
    res.status(500).json({ error: 'Error al aprobar la solicitud' });
  }
});

app.post('/api/returns/reject', async (req, res) => {
  const { requestId, reason } = req.body;
  try {
    const returnReq = await prisma.returnRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED' }
    });

    const mensajeRechazado =
      `❌ *SOLICITUD DE ${returnReq.type} DENEGADA*\n\n` +
      `Lamentablemente no podemos proceder con tu solicitud para la Orden *#${returnReq.orderId.slice(0, 8)}*.\n` +
      `Motivo: ${reason || 'El producto no cumple con los requisitos de estado (debe conservarse en óptimas condiciones y con empaque original).'}\n\n` +
      `📩 Consultas o soporte a: relaxmy89@gmail.com`;

    await safeSendWhatsApp(returnReq.phone, mensajeRechazado);
    res.json({ success: true, message: 'Solicitud rechazada en BD. WhatsApp no disponible en serverless.', returnReq });
  } catch (error) {
    console.error('Error al rechazar solicitud:', error);
    res.status(500).json({ error: 'Error al rechazar la solicitud' });
  }
});

app.post('/api/returns/update-status', async (req, res) => {
  const { requestId, status } = req.body;
  try {
    const returnReq = await prisma.returnRequest.update({
      where: { id: requestId },
      data: { status }
    });

    let mensajeWhatsApp = '';
    if (status === 'SHIPPED') {
      mensajeWhatsApp = `🚚 *¡TU ${returnReq.type} HA SIDO ENVIADO!*\n\nHola! Te notificamos que el paquete correspondiente a tu ${returnReq.type.toLowerCase()} para la Orden *#${returnReq.orderId.slice(0, 8)}* ya está en camino a tu domicilio.\n\n📩 Consultas a: *soportekicks@gmail.com*`;
    } else if (status === 'DELIVERED') {
      mensajeWhatsApp = `🎉 *¡${returnReq.type} ENTREGADO CON ÉXITO!*\n\nHola! Te confirmamos que la gestión de tu ${returnReq.type.toLowerCase()} (Orden *#${returnReq.orderId.slice(0, 8)}*) ha sido completada y entregada correctamente. ¡Muchas gracias por tu paciencia!\n\n📩 Consultas a: *soportekicks@gmail.com*`;
    }

    if (mensajeWhatsApp) {
      await safeSendWhatsApp(returnReq.phone, mensajeWhatsApp);
    }

    res.json({ success: true, message: `Estado de la devolución actualizado a ${status}`, returnReq });
  } catch (error) {
    console.error('Error al actualizar estado de la devolución:', error);
    res.status(500).json({ error: 'Error al actualizar el estado de la solicitud.' });
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
