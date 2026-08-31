require('dotenv').config({ override: true });

const { URL } = require('url');
try {
  const originalDb = process.env.DATABASE_URL || '';
  const originalDirect = process.env.DIRECT_URL || '';

  if (originalDb) {
    const u = new URL(originalDb);
    const alreadyPooler = u.hostname.includes('pooler.');
    if (!alreadyPooler) {
      const parts = u.hostname.split('.');
      if (parts.length >= 3) {
        const regionIndex = parts.findIndex(p => p === 'aws' || p.startsWith('aws-') || p.includes('pooler'));
        if (regionIndex !== -1) {
          u.hostname = u.hostname.replace(/\.supabase\.com$/, '.pooler.supabase.com');
        } else {
          u.hostname = u.hostname.replace(/\.supabase\.co$/, '.pooler.supabase.co');
        }
      } else {
        u.hostname = 'aws-0-us-west-2.pooler.supabase.com';
      }
      u.port = '6543';
    }
    if (!u.searchParams.has('sslmode')) u.searchParams.set('sslmode', 'require');
    if (!u.searchParams.has('pgbouncer')) u.searchParams.set('pgbouncer', 'true');
    u.searchParams.set('connection_limit', '5');
    process.env.DATABASE_URL = u.toString();
  }

  if (originalDirect) {
    const d = new URL(originalDirect);
    d.hostname = d.hostname.replace(/\.pooler\./g, '.');
    if (d.port === '6543') d.port = '5432';
    if (!d.searchParams.has('sslmode')) d.searchParams.set('sslmode', 'require');
    d.searchParams.delete('pgbouncer');
    process.env.DIRECT_URL = d.toString();
  } else if (process.env.DATABASE_URL) {
    const d = new URL(process.env.DATABASE_URL);
    d.hostname = d.hostname.replace(/\.pooler\./g, '.');
    d.port = '5432';
    if (!d.searchParams.has('sslmode')) d.searchParams.set('sslmode', 'require');
    d.searchParams.delete('pgbouncer');
    process.env.DIRECT_URL = d.toString();
  }
} catch (e) {
  console.warn('No se pudo ajustar URL de BD:', e.message);
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const { PrismaClient } = require('@prisma/client');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');

const app = express();

const prisma = new PrismaClient({
  log: ['error', 'warn'],
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- LIMPIEZA AUTOMÁTICA DE SESIÓN SI EXISTE UN RESET ---
const authPath = path.join(__dirname, '.wwebjs_auth');
const cachePath = path.join(__dirname, '.wwebjs_cache');

if (process.env.RESET_WA_SESSION === 'true') {
  console.log('🧹 Limpiando sesión previa de WhatsApp...');
  if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
  if (fs.existsSync(cachePath)) fs.rmSync(cachePath, { recursive: true, force: true });
}

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
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

app.use(express.static(path.join(__dirname, 'public')));

const sessionTimeouts = new Map();
const INACTIVITY_LIMIT_MS = 5 * 60 * 1000;
const DOWN_PAYMENT_PERCENTAGE = 0.20;

// --- FUNCIÓN ROBUSTA DE DESCARGA MULTIMEDIA ---
async function safeDownloadMedia(msg, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise(resolve => setTimeout(resolve, 800 * attempt));
      const media = await msg.downloadMedia();
      if (media && media.data) {
        return `data:${media.mimetype};base64,${media.data}`;
      }
    } catch (err) {
      console.warn(`⚠️ Intento ${attempt}/${retries} de descarga multimedia con advertencia:`, err.message || err);
    }
  }
  return null;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- SUBIDA DE MULTIMEDIA ---
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

// --- AUTENTICACIÓN ---
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
    res.status(500).json({ error: 'Error en el servidor al iniciar sesión' });
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

// --- PRODUCTOS & ÓRDENES ---
app.get('/api/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(Array.isArray(products) ? products : []);
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(200).json([]);
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

// --- CARGA MASIVA DE PRODUCTOS DESDE EXCEL ---
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

    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.json({ success: true, message: `Se importaron ${createdCount} productos con éxito.` });
  } catch (error) {
    console.error('Error procesando Excel:', error);
    res.status(500).json({ error: 'Error al procesar la plantilla de Excel.' });
  }
});

// --- GESTIÓN DE DEVOLUCIONES Y CAMBIOS ---
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

    await client.sendMessage(returnReq.phone, mensajeAprobado);

    await prisma.userSession.update({
      where: { phone: returnReq.phone },
      data: { step: 'AWAITING_RETURN_PAYMENT_RECEIPT', currentReturnId: returnReq.id }
    }).catch(() => {});

    res.json({ success: true, message: 'Solicitud aprobada y cliente notificado.', returnReq });
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

    await client.sendMessage(returnReq.phone, mensajeRechazado);
    res.json({ success: true, message: 'Solicitud rechazada y cliente notificado.', returnReq });
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
      await client.sendMessage(returnReq.phone, mensajeWhatsApp);
    }

    res.json({ success: true, message: `Estado de la devolución actualizado a ${status}`, returnReq });
  } catch (error) {
    console.error('Error al actualizar estado de la devolución:', error);
    res.status(500).json({ error: 'Error al actualizar el estado de la solicitud.' });
  }
});

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

// --- CRUD PRODUCTOS ---
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

// --- GENERADOR DE PDF PROFESIONAL Y ESTILIZADO ---
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

      // --- ENCABEZADO Y BRANDING ---
      doc.rect(0, 0, 595.28, 12).fill('#0F172A');
      doc.fillColor('#0F172A').fontSize(24).font('Helvetica-Bold').text('KICKS', 40, 35);
      doc.fillColor('#64748B').fontSize(10).font('Helvetica').text('COMPROBANTE DE PEDIDO', 40, 62);

      doc.fillColor('#0F172A').fontSize(12).font('Helvetica-Bold').text(`ORDEN #${order.id.slice(0, 8).toUpperCase()}`, 350, 38, { align: 'right' });
      doc.fillColor('#64748B').fontSize(9).font('Helvetica').text(`Fecha: ${new Date(order.createdAt).toLocaleString('es-AR')}`, 350, 56, { align: 'right' });

      doc.moveTo(40, 80).lineTo(555, 80).strokeColor('#E2E8F0').lineWidth(1).stroke();

      // --- BADGE DE ESTADO DEL PAGO ---
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

      // --- TABLA DE PRODUCTOS ---
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

      // --- RESUMEN DE TOTALES ---
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

      // --- TARJETAS DE INFORMACIÓN (ENVÍO Y PAGO) ---
      const boxWidth = 250;
      const boxHeight = 110;

      // Tarjeta Envío
      doc.roundedRect(40, startY, boxWidth, boxHeight, 6).fill('#F8FAFC').strokeColor('#E2E8F0').lineWidth(1).stroke();
      doc.fillColor('#0F172A').fontSize(10).font('Helvetica-Bold').text('📦 Datos de Entrega', 52, startY + 12);
      
      doc.fillColor('#475569').fontSize(8.5).font('Helvetica');
      doc.text(`Destinatario: `, 52, startY + 30, { continued: true }).fillColor('#0F172A').font('Helvetica-Bold').text(`${order.recipientName || 'N/A'}`);
      doc.fillColor('#475569').font('Helvetica').text(`Dirección: `, 52, startY + 45, { continued: true }).fillColor('#0F172A').font('Helvetica-Bold').text(`${order.address}`);
      doc.fillColor('#475569').font('Helvetica').text(`Modalidad: `, 52, startY + 60, { continued: true }).fillColor('#0F172A').font('Helvetica-Bold').text(`${order.deliveryOption || 'N/A'}`);
      doc.fillColor('#475569').font('Helvetica').text(`Día/Horario: `, 52, startY + 75, { continued: true }).fillColor('#0F172A').font('Helvetica-Bold').text(`${order.deliveryDay || ''} ${order.deliveryTimeSlot || ''}`);

      // Tarjeta Pago
      doc.roundedRect(305, startY, boxWidth, boxHeight, 6).fill('#F8FAFC').strokeColor('#E2E8F0').lineWidth(1).stroke();
      doc.fillColor('#0F172A').fontSize(10).font('Helvetica-Bold').text('💳 Medio de Pago', 317, startY + 12);

      doc.fillColor('#475569').fontSize(8.5).font('Helvetica');
      doc.text(`Método Seleccionado:`, 317, startY + 30);
      doc.fillColor('#2563EB').fontSize(10).font('Helvetica-Bold').text(`${order.payment}`, 317, startY + 44);

      // --- PIE DE PÁGINA ---
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

// --- CLIENTE DE WHATSAPP WEB ---
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    protocolTimeout: 240000,
    handleSIGINT: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

// 📌 CÓDIGO QR MOSTRADO EXCLUSIVAMENTE EN TERMINAL
client.on('qr', (qr) => {
  console.log('\n================================================--');
  console.log('📱 ESCANEA ESTE CÓDIGO QR CON WHATSAPP');
  console.log('================================================--\n');
  qrcodeTerminal.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('🟢 Bot de WhatsApp conectado y listo.');
});

function resetInactivityTimer(phone) {
  if (sessionTimeouts.has(phone)) {
    clearTimeout(sessionTimeouts.get(phone));
  }

  const timeout = setTimeout(async () => {
    try {
      const session = await prisma.userSession.findUnique({ where: { phone } });
      if (session && session.step !== 'IDLE') {
        await prisma.userSession.update({
          where: { phone },
          data: { step: 'AWAITING_INACTIVITY_DECISION' }
        });

        await client.sendMessage(phone, 
          `⏳ *¿Sigues allí?*\n\n` +
          `Notamos que demoraste en completar tu solicitud.\n\n` +
          `1. Deseo *continuar*\n` +
          `2. Deseo *anular y cancelar*\n\n` +
          `Responde con *1* para seguir o *2* para anular.`
        );
      }
    } catch (err) {
      console.error('Error al manejar temporizador de inactividad:', err);
    }
  }, INACTIVITY_LIMIT_MS);

  sessionTimeouts.set(phone, timeout);
}

function clearInactivityTimer(phone) {
  if (sessionTimeouts.has(phone)) {
    clearTimeout(sessionTimeouts.get(phone));
    sessionTimeouts.delete(phone);
  }
}

// --- ACCIONES DE ADMINISTRACIÓN PARA ÓRDENES ---
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

    await client.sendMessage(order.phone, mensajeAprobado);

    try {
      const pdfBuffer = await generateOrderPDFBuffer(order);
      const pdfMedia = new MessageMedia(
        'application/pdf', 
        pdfBuffer.toString('base64'), 
        `Comprobante_Aprobado_Orden_${order.id.slice(0, 8)}.pdf`
      );

      await client.sendMessage(order.phone, pdfMedia, {
        caption: `📄 *Comprobante de Pago Aprobado - Orden #${order.id.slice(0, 8)}*`
      });
    } catch (pdfErr) {
      console.error('Error generando/enviando el PDF aprobado:', pdfErr);
    }

    res.json({ success: true, message: 'Pago aprobado, cliente notificado y PDF enviado.', order });
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

    await client.sendMessage(order.phone, mensajeRechazado);
    res.json({ success: true, message: 'Pago denegado y cliente notificado.', order });
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

    await client.sendMessage(order.phone, mensajeWhatsApp);
    res.json({ success: true, message: `Estado actualizado a ${status} y cliente notificado.`, order });
  } catch (error) {
    console.error('Error al actualizar estado:', error);
    res.status(500).json({ error: 'Error al actualizar el estado de la orden' });
  }
});

// --- MENSAJES DE WHATSAPP ENTRANTES ---
client.on('message', async (msg) => {
  const from = msg.from;
  const text = msg.body.trim();

  if (from.endsWith('@g.us')) return;

  try {
    let session = await prisma.userSession.findUnique({ where: { phone: from } });

    if (!session) {
      session = await prisma.userSession.create({ data: { phone: from, step: 'IDLE', cartJson: '[]' } });
    }

    let cart = JSON.parse(session.cartJson || '[]');

    const sendMainMenu = async () => {
      await prisma.userSession.update({ where: { phone: from }, data: { step: 'IDLE' } });
      return client.sendMessage(from, 
        `👋 *¡Hola! Bienvenido a KICKS*\n\n` +
        `¿En qué podemos ayudarte hoy?\n\n` +
        `1️⃣ Realizar una nueva compra\n` +
        `2️⃣ Gestionar un *CAMBIO* de producto\n` +
        `3️⃣ Gestionar una *DEVOLUCIÓN* de producto\n` +
        `4️⃣ Solicitar *ASISTENCIA* o soporte\n\n` +
        `Responde con el número *1*, *2*, *3* o *4*.`
      );
    };

    if (session.step === 'IDLE' && !text.includes('quiero comprar el producto') && !text.includes('PEDIDO MÚLTIPLE') && !text.includes('PEDIDO MULTIPLE') && !text.includes('quiero comprar estos productos')) {
      const option = text.toLowerCase();

      if (option === '1' || option.includes('comprar') || option.includes('compra')) {
        const webUrl = process.env.WEB_URL || 'https://kicks-ar.vercel.app/';
        return client.sendMessage(from, 
          `Puedes explorar nuestros productos y realizar tu pedido directamente aquí:\n` +
          `👉 ${webUrl}`,
          { linkPreview: false }
        );
      } else if (option === '2' || option.includes('cambio')) {
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'RETURN_ASK_ORDER_ID', returnType: 'CAMBIO' }
        });
        return client.sendMessage(from, 
          `🔄 *Solicitud de CAMBIO*\n\n` +
          `Por favor, ingresa tu **Número de Orden**.\n` +
          `_(Lo encuentras en tu comprobante o resumen. Ejemplo: 1659201e)_`
        );
      } else if (option === '3' || option.includes('devolución') || option.includes('devolucion')) {
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'RETURN_ASK_ORDER_ID', returnType: 'DEVOLUCION' }
        });
        return client.sendMessage(from, 
          `↩️ *Solicitud de DEVOLUCIÓN*\n\n` +
          `Por favor, ingresa tu **Número de Orden**.\n` +
          `_(Lo encuentras en tu comprobante o resumen. Ejemplo: 1659201e)_`
        );
      } else if (option === '4' || option.includes('asistencia') || option.includes('soporte') || option.includes('ayuda')) {
        return client.sendMessage(from, 
          `👨‍💻 *Atención al Cliente*\n\n` +
          `Un representante de nuestro equipo revisará tu mensaje y se pondrá en contacto contigo a la brevedad.\n\n` +
          `También puedes escribirnos a nuestro correo oficial: *soportekicks@gmail.com*`
        );
      } else if (/^[1-9][0-9]?$/.test(text.trim()) && session.tempData) {
        try {
          const candidatosIds = JSON.parse(session.tempData);
          const opcion = parseInt(text.trim(), 10);
          if (opcion >= 1 && opcion <= candidatosIds.length) {
            const productId = candidatosIds[opcion - 1];
            const product = await prisma.product.findUnique({ where: { id: productId } });

            if (!product || product.isAvailable === false) {
              return client.sendMessage(from, 'Lo sentimos, este producto no se encuentra disponible.');
            }

            await prisma.userSession.update({
              where: { phone: from },
              data: {
                step: 'CONFIRM_SIZE',
                currentProdId: product.id,
                tempData: null
              }
            });

            const caption =
              `¡Hola! 👋 Soy *Luci*, tu asistente virtual en *KICKS.ar*🛒.\n\n` +
              `Agregando a tu pedido: *${product.name}*\n` +
              `${product.description ? `\n📝 _${product.description}_\n` : ''}` +
              `\nPor favor, responde con el *talle / variante* que buscas (${product.sizes.join(', ')}):`;

            let displayImg = (product.images && product.images.length > 0) ? product.images[0] : product.imageUrl;
            if (displayImg) {
              try {
                const baseUrl = process.env.WEB_URL || 'https://kicks-ar.vercel.app/';
                const fullImgUrl = displayImg.startsWith('http')
                  ? displayImg
                  : `${baseUrl.replace(/\/$/, '')}/${displayImg.replace(/^\//, '')}`;
                const media = await MessageMedia.fromUrl(fullImgUrl, { unsafeMime: true });
                return client.sendMessage(from, media, { caption });
              } catch (e) {
                console.error('Error al enviar imagen por WhatsApp:', e.message);
              }
            }
            return client.sendMessage(from, caption);
          } else {
            return client.sendMessage(from, `Opción inválida. Por favor, elige un número entre 1 y ${candidatosIds.length}.`);
          }
        } catch (e) {
          return sendMainMenu();
        }
      } else {
        return sendMainMenu();
      }
    }

    // --- REINICIO Y VOLVER AL MENÚ SI NO SE ENCUENTRA LA ORDEN ---
    if (session.step === 'RETURN_ASK_ORDER_ID') {
      const cleanOrderId = text.replace('#', '').trim();

      const existingOrder = await prisma.order.findFirst({
        where: { id: { contains: cleanOrderId } }
      });

      if (!existingOrder) {
        await client.sendMessage(from, 
          `⚠️ *Orden no encontrada*\n\n` +
          `No encontramos ningún pedido registrado con el código *"${cleanOrderId}"*.\n` +
          `Redirigiendo al menú principal...`
        );

        return sendMainMenu();
      }

      await prisma.userSession.update({
        where: { phone: from },
        data: { step: 'RETURN_ASK_CONDITION', tempOrderId: existingOrder.id }
      });

      return client.sendMessage(from, 
        `🔍 *Estado del Producto*\n\n` +
        `Para gestionar tu solicitud de la Orden *#${existingOrder.id.slice(0, 8)}*, indicanos:\n` +
        `*¿En qué estado se encuentra el producto?*\n\n` +
        `1. Excelente estado, sin uso y en empaque/etiquetas originales.\n` +
        `2. Sin empaque original pero completamente sin uso.\n` +
        `3. Presenta marcas de uso o desgaste.\n\n` +
        `Responde con el número *1*, *2* o *3*.`
      );
    }

    if (session.step === 'RETURN_ASK_CONDITION') {
      let conditionText = '';
      if (text === '1') conditionText = 'Excelente estado, sin uso con empaque original';
      else if (text === '2') conditionText = 'Sin empaque, sin uso';
      else if (text === '3') conditionText = 'Con marcas de uso / desgaste';
      else conditionText = text;

      await prisma.userSession.update({
        where: { phone: from },
        data: { step: 'RETURN_ASK_REASON', tempCondition: conditionText }
      });

      return client.sendMessage(from, 
        `📝 Por favor, escribe brevemente el *motivo* de tu ${session.returnType?.toLowerCase() || 'solicitud'}:`
      );
    }

    if (session.step === 'RETURN_ASK_REASON') {
      await prisma.userSession.update({
        where: { phone: from },
        data: { step: 'RETURN_ASK_IMAGE', tempData: text }
      });

      return client.sendMessage(from, 
        `📸 *Foto del Producto*\n\n` +
        `Por favor, envía por este medio una *foto clara del producto* que deseas cambiar o devolver para que el equipo pueda evaluar su estado.`
      );
    }

    if (session.step === 'RETURN_ASK_IMAGE') {
      if (msg.hasMedia) {
        const returnReq = await prisma.returnRequest.create({
          data: {
            orderId: session.tempOrderId,
            phone: from,
            type: session.returnType === 'DEVOLUCION' ? 'DEVOLUCION' : 'CAMBIO',
            productCondition: session.tempCondition || 'Sin especificar',
            reason: session.tempData || 'Sin motivo especificado',
            imageUrl: null
          }
        });

        safeDownloadMedia(msg).then(async (photoUrl) => {
          if (photoUrl) {
            await prisma.returnRequest.update({
              where: { id: returnReq.id },
              data: { imageUrl: photoUrl }
            }).catch(() => {});
          }
        });

        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'IDLE', tempOrderId: null, tempCondition: null, tempData: null, returnType: null }
        });

        return client.sendMessage(from, 
          `📥 *¡Solicitud de ${returnReq.type} Registrada!*\n\n` +
          `Hemos recibido la información para la Orden *#${returnReq.orderId.slice(0, 8)}*.\n\n` +
          `📌 *Pasos siguientes:*\n` +
          `• Nuestro equipo evaluará la solicitud.\n` +
          `• De ser aprobada, te enviaremos el costo del envío y los datos para realizar la gestión.\n\n` +
          `Nos comunicaremos por este medio a la brevedad.`
        );
      } else {
        return client.sendMessage(from, 'Por favor, envía una foto del producto adjuntándola como imagen.');
      }
    }

    if (session.step === 'AWAITING_RETURN_PAYMENT_RECEIPT') {
      if (msg.hasMedia) {
        clearInactivityTimer(from);

        if (session.currentReturnId) {
          await prisma.returnRequest.update({
            where: { id: session.currentReturnId },
            data: { status: 'PAYMENT_IN_REVIEW', shippingReceiptUrl: 'Comprobante Recibido' }
          });

          safeDownloadMedia(msg).then(async (receiptDataUrl) => {
            if (receiptDataUrl) {
              await prisma.returnRequest.update({
                where: { id: session.currentReturnId },
                data: { shippingReceiptUrl: receiptDataUrl }
              }).catch(() => {});
            }
          });
        }

        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'IDLE', currentReturnId: null }
        });

        return client.sendMessage(from, 
          `🙌 *Comprobante de pago de envío recibido con éxito.*\n\n` +
          `Estamos validando la acreditación. Una vez verificado, coordinaremos la recolección o despacho de tu paquete. ¡Gracias!`
        );
      } else {
        return client.sendMessage(from, 'Por favor, adjunta o envía la foto del comprobante de transferencia.');
      }
    }

    if (session.step === 'AWAITING_INACTIVITY_DECISION') {
      const choice = text.trim();

      if (choice === '1' || choice.toLowerCase().includes('continuar')) {
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'CONFIRM_SHIPPING' }
        });
        resetInactivityTimer(from);
        return client.sendMessage(from, '👍 ¡Excelente! Continuemos. Ingresa tu *dirección completa de envío* (Calle, Número, Ciudad):');
      } else if (choice === '2' || choice.toLowerCase().includes('anular') || choice.toLowerCase().includes('eliminar')) {
        clearInactivityTimer(from);

        const pendingOrders = await prisma.order.findMany({
          where: {
            phone: from,
            status: { in: ['PENDING_PAYMENT', 'PAYMENT_IN_REVIEW', 'PENDING'] }
          },
          orderBy: { createdAt: 'desc' }
        });

        let cancelledOrderMsg = '';
        if (pendingOrders.length > 0) {
          const ids = pendingOrders.map(o => `#${o.id.slice(0, 8)}`).join(', ');
          await prisma.order.updateMany({
            where: {
              phone: from,
              status: { in: ['PENDING_PAYMENT', 'PAYMENT_IN_REVIEW', 'PENDING'] }
            },
            data: { status: 'CANCELLED' }
          });
          cancelledOrderMsg = ` Solicitud/es cancelada/s: ${ids}.`;
        }

        await prisma.userSession.update({
          where: { phone: from },
          data: { 
            step: 'IDLE', 
            cartJson: '[]',
            currentOrderId: null, 
            shippingAddr: null,
            recipientName: null,
            deliveryOption: null,
            deliveryDay: null,
            deliveryTimeSlot: null
          }
        });
        return client.sendMessage(from, `🗑️ *Solicitud anulada*.${cancelledOrderMsg} Se limpió el carrito y los datos pendientes.\n\nSi deseas operar nuevamente, responde con *MENU* o visita la tienda web.`);
      } else {
        return client.sendMessage(from, 'Por favor, responde con *1* para continuar o *2* para anular.');
      }
    }

    resetInactivityTimer(from);

    if (session.step === 'AWAITING_EXTRA_PRODUCT_OR_CONTINUE' && text.toUpperCase() === 'C') {
      await prisma.userSession.update({
        where: { phone: from },
        data: { step: 'CONFIRM_SHIPPING' }
      });
      return client.sendMessage(from, 'Anotado. Ingresa tu *dirección completa de envío* (Calle, Número, Ciudad):');
    }

    // --- CAPTURA DE CARRITO MÚLTIPLE ---
    if (text.includes('PEDIDO MÚLTIPLE') || text.includes('quiero comprar estos productos') || text.includes('PEDIDO MULTIPLE')) {
      const matchUser = text.match(/USER:\s*([a-f0-9\-]+)/i);
      const userId = matchUser ? matchUser[1].trim() : null;

      const matchShipping = text.match(/(?:Envío|Direcci[oó]n|Domicilio|Entrega)\s*[:：]\s*([^\n\r]+)/i);
      const providedShipping = matchShipping ? matchShipping[1].trim() : null;

      const blocksRegex = /\d+\.\s*([^\n]+)[\s\S]*?Cantidad:\s*(\d+)([\s\S]*?)ID:\s*([a-f0-9\-]+)/gi;
      const rawItems = [];
      let bMatch;
      while ((bMatch = blocksRegex.exec(text)) !== null) {
        const blockChunk = bMatch[0];
        const sizeMatch = blockChunk.match(/Talle:\s*([^\n\r]+)/i);
        const colorMatch = blockChunk.match(/Color:\s*([^\n\r]+)/i);
        rawItems.push({
          nameRaw: bMatch[1].trim(),
          qtyRaw: bMatch[2],
          productId: bMatch[4].trim(),
          sizeRaw: sizeMatch ? sizeMatch[1].trim() : null,
          colorRaw: colorMatch ? colorMatch[1].trim() : null
        });
      }

      if (rawItems.length === 0) {
        const idPositions = [];
        const idRegex = /ID:\s*([a-f0-9\-]+)/gi;
        let idMatch;
        while ((idMatch = idRegex.exec(text)) !== null) {
          idPositions.push({ id: idMatch[1].trim(), index: idMatch.index });
        }
        for (const pos of idPositions) {
          const beforeId = text.slice(Math.max(0, pos.index - 300), pos.index);
          const qtyMatch = beforeId.match(/Cantidad:\s*(\d+)/i);
          const qty = qtyMatch ? qtyMatch[1] : '1';
          const sizeMatch = beforeId.match(/Talle:\s*([^\n\r]+)/i);
          const colorMatch = beforeId.match(/Color:\s*([^\n\r]+)/i);
          rawItems.push({
            productId: pos.id,
            qtyRaw: qty,
            nameRaw: '',
            sizeRaw: sizeMatch ? sizeMatch[1].trim() : null,
            colorRaw: colorMatch ? colorMatch[1].trim() : null
          });
        }
      }

      const queue = [];
      const errores = [];

      for (const it of rawItems) {
        const qty = Math.max(1, parseInt(it.qtyRaw || '1', 10) || 1);
        const product = await prisma.product.findUnique({ where: { id: it.productId } });
        if (!product || product.isAvailable === false) {
          errores.push(`- ID ${it.productId}: no disponible`);
          continue;
        }
        if (Number(product.stock) < qty) {
          errores.push(`- *${product.name}*: stock insuficiente (hay ${product.stock}, pediste ${qty})`);
          continue;
        }

        let size = null;
        if (it.sizeRaw && product.sizes && product.sizes.length > 0) {
          const up = it.sizeRaw.toUpperCase();
          size = product.sizes.find(s => String(s).trim().toUpperCase() === up) || it.sizeRaw;
        } else if (product.sizes && product.sizes.length === 1) {
          size = product.sizes[0];
        }

        let color = null;
        if (it.colorRaw && product.colors && product.colors.length > 0) {
          const low = it.colorRaw.toLowerCase();
          color = product.colors.find(c => c.trim().toLowerCase() === low) || it.colorRaw;
        } else if (product.colors && product.colors.length === 1) {
          color = product.colors[0];
        }

        queue.push({
          productId: product.id,
          name: product.name,
          qty,
          size,
          color,
          needsSize: !!(product.sizes && product.sizes.length > 0 && !size),
          needsColor: !!(product.colors && product.colors.length > 0 && !color)
        });
      }

      if (queue.length === 0) {
        return client.sendMessage(from,
          `⚠️ No pudimos cargar los productos del carrito${errores.length ? `:\n${errores.join('\n')}` : '.'}\n\nPor favor, volvé a intentarlo desde la tienda.`
        );
      }

      const allResolved = queue.every(q => !q.needsSize && !q.needsColor);
      cart = [];

      if (allResolved) {
        let subtotal = 0;
        const resumenLines = [];
        for (const [idx, q] of queue.entries()) {
          const p = await prisma.product.findUnique({ where: { id: q.productId } });
          let price = Number(p.price);
          if (p.promoType === 'PERCENTAGE' && p.discountPercent > 0) {
            price = price - (price * (p.discountPercent / 100));
          }
          for (let i = 0; i < q.qty; i++) {
            cart.push({
              productId: q.productId,
              name: q.name,
              size: q.size,
              color: q.color,
              price
            });
          }
          subtotal += price * q.qty;
          resumenLines.push(`${idx + 1}. *${q.name}* × ${q.qty}` +
            (q.size ? ` (Talle ${q.size})` : '') +
            (q.color ? ` (Color ${q.color})` : '') +
            ` - ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(price * q.qty)}`);
        }
        const fmtSub = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(subtotal);

        const updateData = {
          step: 'ASK_MORE_PRODUCTS',
          currentProdId: null,
          currentSize: null,
          currentColor: null,
          userId: userId || null,
          cartJson: JSON.stringify(cart),
          shippingAddr: providedShipping || null,
          tempData: null
        };
        await prisma.userSession.update({ where: { phone: from }, data: updateData });

        const totalUnidades = queue.reduce((s, it) => s + it.qty, 0);
        const lines = [];
        lines.push(`¡Hola! 👋 Soy *Luci*, tu asistente virtual en *KICKS.ar*🛒.\n`);
        lines.push(`✅ Recibí tu pedido de *${queue.length} artículo${queue.length === 1 ? '' : 's'}* (${totalUnidades} unidades).\n`);
        lines.push(`Confirmemos los datos:\n`);
        lines.push(`📋 Resumen:\n${resumenLines.join('\n')}\n`);
        lines.push(`💰 *Subtotal: ${fmtSub}*`);
        if (providedShipping) lines.push(`📍 Envío a: *${providedShipping}*`);
        lines.push(``);
        lines.push(`¿Deseas agregar *otro producto* a tu compra?\n\n`);
        lines.push(`1. Sí, quiero agregar otro producto\n`);
        lines.push(`2. No, continuar con los datos de envío y pago\n\n`);
        lines.push(`Responde con el número *1* o *2*.`);
        return client.sendMessage(from, lines.join('\n'));
      }

      const multiData = { isMulti: true, multiIndex: 0, multiQueue: queue };
      await prisma.userSession.update({
        where: { phone: from },
        data: {
          step: 'CONFIRM_SIZE',
          currentProdId: queue[0].productId,
          userId: userId || null,
          cartJson: '[]',
          shippingAddr: providedShipping || null,
          tempData: JSON.stringify(multiData)
        }
      });

      const primerProducto = await prisma.product.findUnique({ where: { id: queue[0].productId } });
      const q0 = queue[0];
      const caption =
        `¡Hola! 👋 Soy *Luci*, tu asistente virtual en *KICKS.ar*🛒.\n\n` +
        `📦 Recibí tu pedido de *${queue.length} artículo${queue.length === 1 ? '' : 's'}* (${queue.reduce((s, it) => s + it.qty, 0)} unidades en total).\n` +
        (providedShipping ? `📍 Envío a: *${providedShipping}*\n` : '') +
        `\nVamos a confirmar uno por uno. Empezamos con:\n` +
        `*${primerProducto.name}* × ${q0.qty}\n` +
        (q0.size ? `📏 Talle precargado: *${q0.size}*\n` : '') +
        (q0.color ? `🎨 Color precargado: *${q0.color}*\n` : '') +
        `${primerProducto.description ? `\n📝 _${primerProducto.description}_\n` : ''}` +
        (q0.needsSize
          ? `\nPor favor, responde con el *talle / variante* (${primerProducto.sizes.join(', ')}):`
          : q0.needsColor
            ? `\nPor favor, responde con el *color* (${primerProducto.colors.join(', ')}):`
            : `\nConfirmado.`);

      let displayImg = (primerProducto.images && primerProducto.images.length > 0) ? primerProducto.images[0] : primerProducto.imageUrl;
      if (displayImg) {
        try {
          const baseUrl = process.env.WEB_URL || 'https://kicks-ar.vercel.app/';
          const fullImgUrl = displayImg.startsWith('http')
            ? displayImg
            : `${baseUrl.replace(/\/$/, '')}/${displayImg.replace(/^\//, '')}`;
          const media = await MessageMedia.fromUrl(fullImgUrl, { unsafeMime: true });
          return client.sendMessage(from, media, { caption });
        } catch (e) {
          console.error('Error al enviar imagen por WhatsApp:', e.message);
        }
      }
      return client.sendMessage(from, caption);
    }

    // --- CAPTURA DE MENSAJE DE TIENDA (por NOMBRE o por ID) ---
    if (text.includes('quiero comprar el producto')) {
      const match = text.match(/ID:\s*([a-f0-9\-]+)/i);
      const productId = match ? match[1].trim() : null;

      const matchUser = text.match(/USER:\s*([a-f0-9\-]+)/i);
      const userId = matchUser ? matchUser[1].trim() : null;

      const matchQty = text.match(/Cantidad:\s*(\d+)/i);
      const providedQty = matchQty ? Math.max(1, parseInt(matchQty[1], 10) || 1) : 1;

      const matchSize = text.match(/Talle:\s*([^\n\r]+)/i);
      const providedSize = matchSize ? matchSize[1].trim() : null;

      const matchColor = text.match(/Color:\s*([^\n\r]+)/i);
      const providedColor = matchColor ? matchColor[1].trim() : null;

      const matchShipping = text.match(/(?:Envío|Direcci[oó]n|Domicilio|Entrega)\s*[:：]\s*([^\n\r]+)/i);
      const providedShipping = matchShipping ? matchShipping[1].trim() : null;

      let product = null;

      if (productId) {
        product = await prisma.product.findUnique({ where: { id: productId } });
      }

      if (!product) {
        const nombreMatch = text.match(/quiero comprar el producto:\s*(.+)$/im);
        let nombreProducto = nombreMatch ? nombreMatch[1].trim() : '';

        if (!nombreProducto) {
          const nombreMatchSimple = text.match(/:\s*([^:\n\r]+)$/m);
          if (nombreMatchSimple) nombreProducto = nombreMatchSimple[1].trim();
        }

        nombreProducto = nombreProducto
          .replace(/\(.*?\)/g, '')
          .replace(/\bUSER:\s*\S+/gi, '')
          .trim();

        if (nombreProducto && nombreProducto.length > 0) {
          const nombreLimpio = nombreProducto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const todosLosProductos = await prisma.product.findMany({
            where: { isAvailable: true }
          });

          const candidatos = todosLosProductos.filter(p => {
            const n = (p.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (!n) return false;
            if (n === nombreLimpio) return true;
            if (n.includes(nombreLimpio) || nombreLimpio.includes(n)) return true;
            const palabras = nombreLimpio.split(/\s+/).filter(w => w.length >= 3);
            return palabras.length >= 1 && palabras.every(palabra => n.includes(palabra));
          });

          if (candidatos.length === 1) {
            product = candidatos[0];
          } else if (candidatos.length > 1) {
            await prisma.userSession.update({
              where: { phone: from },
              data: { step: 'IDLE', tempData: JSON.stringify(candidatos.map(c => c.id)) }
            });
            const opciones = candidatos.slice(0, 5).map((c, i) => `${i + 1}. ${c.name}`).join('\n');
            return client.sendMessage(from,
              `🔍 Encontré *${candidatos.length} productos* con un nombre similar. Por favor, indícame cuál es:\n\n${opciones}\n\nResponde con el *número* (ej: 1, 2, ...)`
            );
          }
        }
      }

      if (!product || product.isAvailable === false) {
        return client.sendMessage(from, 'Lo sentimos, no pudimos identificar ese producto o ya no se encuentra disponible.');
      }

      let finalSize = null;
      if (providedSize && product.sizes && product.sizes.length > 0) {
        const up = providedSize.toUpperCase();
        finalSize = product.sizes.find(s => String(s).trim().toUpperCase() === up) || providedSize;
      } else if (product.sizes && product.sizes.length === 1) {
        finalSize = product.sizes[0];
      }

      let finalColor = null;
      if (providedColor && product.colors && product.colors.length > 0) {
        const low = providedColor.toLowerCase();
        finalColor = product.colors.find(c => c.trim().toLowerCase() === low) || providedColor;
      } else if (product.colors && product.colors.length === 1) {
        finalColor = product.colors[0];
      }

      const needsSize = product.sizes && product.sizes.length > 0 && !finalSize;
      const needsColor = product.colors && product.colors.length > 0 && !finalColor;

      let displayPrice = Number(product.price);
      if (product.promoType === 'PERCENTAGE' && product.discountPercent > 0) {
        displayPrice = displayPrice - (displayPrice * (product.discountPercent / 100));
      }
      const fmtPrice = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(displayPrice);

      let newCart = [];
      for (let i = 0; i < providedQty; i++) {
        newCart.push({
          productId: product.id,
          name: product.name,
          size: finalSize,
          color: finalColor,
          price: displayPrice
        });
      }

      if (!needsSize && !needsColor) {
        const updateData = {
          step: 'ASK_MORE_PRODUCTS',
          currentProdId: null,
          currentSize: finalSize,
          currentColor: finalColor,
          cartJson: JSON.stringify(newCart),
          userId: userId || null,
          shippingAddr: providedShipping || null
        };
        await prisma.userSession.update({ where: { phone: from }, data: updateData });

        const lines = [];
        lines.push(`¡Hola! 👋 Soy *Luci*, tu asistente virtual en *KICKS.ar*🛒.\n`);
        lines.push(`✅ Recibí tu selección. Confirmemos los datos:\n`);
        lines.push(`📦 Producto: *${product.name}*`);
        lines.push(`🔢 Cantidad: *${providedQty}*`);
        if (finalSize) lines.push(`📏 Talle: *${finalSize}*`);
        if (finalColor) lines.push(`🎨 Color: *${finalColor}*`);
        lines.push(`💲 Precio unitario: *${fmtPrice}*`);
        if (providedShipping) lines.push(`📍 Envío a: *${providedShipping}*\n`);
        lines.push(`\n💰 *Subtotal: ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(displayPrice * providedQty)}*\n`);
        lines.push(`\n¿Deseas agregar *otro producto* a tu compra?\n\n`);
        lines.push(`1. Sí, quiero agregar otro producto\n`);
        lines.push(`2. No, continuar con los datos de envío y pago\n\n`);
        lines.push(`Responde con el número *1* o *2*.`);
        return client.sendMessage(from, lines.join('\n'));
      }

      await prisma.userSession.update({
        where: { phone: from },
        data: {
          step: needsSize ? 'CONFIRM_SIZE' : 'CONFIRM_COLOR',
          currentProdId: product.id,
          currentSize: finalSize,
          currentColor: finalColor,
          userId: userId || null,
          shippingAddr: providedShipping || null,
          tempQty: providedQty
        }
      });

      const caption = 
        `¡Hola! 👋 Soy *Luci*, tu asistente virtual en *KICKS.ar*🛒.\n\n` +
        `Agregando a tu pedido: *${product.name}*\n` +
        (finalSize ? `📏 Talle precargado: *${finalSize}*\n` : '') +
        (finalColor ? `🎨 Color precargado: *${finalColor}*\n` : '') +
        (providedShipping ? `📍 Envío a: *${providedShipping}*\n` : '') +
        `${product.description ? `\n📝 _${product.description}_\n` : ''}` +
        (needsSize
          ? `\nPor favor, confirma el *talle / variante* (${product.sizes.join(', ')}):`
          : `\nPor favor, confirma el *color* (${product.colors.join(', ')}):`);

      let displayImg = (product.images && product.images.length > 0) ? product.images[0] : product.imageUrl;

      if (displayImg) {
        try {
          const baseUrl = process.env.WEB_URL || 'https://kicks-ar.vercel.app/';
          const fullImgUrl = displayImg.startsWith('http') 
            ? displayImg 
            : `${baseUrl.replace(/\/$/, '')}/${displayImg.replace(/^\//, '')}`;
          const media = await MessageMedia.fromUrl(fullImgUrl, { unsafeMime: true });
          return client.sendMessage(from, media, { caption });
        } catch (e) {
          console.error('Error al enviar imagen por WhatsApp:', e.message);
          return client.sendMessage(from, caption);
        }
      }
      return client.sendMessage(from, caption);
    }

    if (session.step === 'CONFIRM_SIZE') {
      const product = await prisma.product.findUnique({ where: { id: session.currentProdId } });

      if (!product) {
        await prisma.userSession.update({ where: { phone: from }, data: { step: 'IDLE' } });
        return client.sendMessage(from, 'Ocurrió un problema con el producto seleccionado. Por favor, selecciona nuevamente desde la web.');
      }

      let talleFinal = session.currentSize;
      if (!talleFinal) {
        const sizeInput = text.trim().toUpperCase();
        const talleEncontrado = product.sizes.find(s => String(s).trim().toUpperCase() === sizeInput);

        if (!talleEncontrado && product.sizes.length > 0) {
          return client.sendMessage(
            from,
            `⚠️ El talle *"${text}"* no está disponible para este modelo.\n\n` +
            `Por favor, elige uno de los siguientes talles disponibles: *${product.sizes.join(', ')}*`
          );
        }
        talleFinal = talleEncontrado || text.trim();
      }

      const hasColors = product.colors && product.colors.length > 0;
      const colorPrecargado = session.currentColor;

      if (hasColors && !colorPrecargado) {
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'CONFIRM_COLOR', currentSize: talleFinal }
        });

        const coloresDisponibles = product.colors.join(', ');
        return client.sendMessage(
          from,
          `Perfecto. ¿En qué *color* prefieres tu producto?\n\n` +
          `Colores disponibles: *${coloresDisponibles}*`
        );
      }

      await prisma.userSession.update({
        where: { phone: from },
        data: { step: 'CONFIRM_COLOR', currentSize: talleFinal, currentColor: colorPrecargado || null }
      });
      session.step = 'CONFIRM_COLOR';
      session.currentSize = talleFinal;
      session.currentColor = colorPrecargado || null;
      text = 'COLOR_PRELOAD_SKIP';
    }

    if (session.step === 'CONFIRM_COLOR') {
      const product = await prisma.product.findUnique({ where: { id: session.currentProdId } });

      if (!product) {
        await prisma.userSession.update({ where: { phone: from }, data: { step: 'IDLE' } });
        return client.sendMessage(from, 'Ocurrió un error al buscar el producto. Intenta reiniciar la compra desde la tienda.');
      }

      let colorFinal = session.currentColor;
      if (!colorFinal) {
        const colorInput = text.trim().toLowerCase();
        const colorEncontrado = product.colors.find(c => c.trim().toLowerCase() === colorInput);

        if (!colorEncontrado && product.colors.length > 0) {
          return client.sendMessage(
            from,
            `⚠️ El color *"${text}"* no está disponible para este modelo.\n\n` +
            `Por favor, escribe exactamente uno de los colores disponibles: *${product.colors.join(', ')}*`
          );
        }
        colorFinal = colorEncontrado || text.trim();
      }

      let finalPrice = Number(product.price);
      if (product.promoType === 'PERCENTAGE' && product.discountPercent > 0) {
        finalPrice = finalPrice - (finalPrice * (product.discountPercent / 100));
      }

      const sizeForCart = session.currentSize || null;

      // ---------- LÓGICA DE CARRITO MÚLTIPLE ----------
      let multiData = null;
      try { multiData = session.tempData ? JSON.parse(session.tempData) : null; } catch (e) { multiData = null; }
      let qtyForCurrent = 1;
      if (multiData && multiData.isMulti && multiData.multiQueue && multiData.multiQueue[multiData.multiIndex]) {
        qtyForCurrent = Math.max(1, Number(multiData.multiQueue[multiData.multiIndex].qty) || 1);
      }
      for (let i = 0; i < qtyForCurrent; i++) {
        cart.push({
          productId: product.id,
          name: product.name,
          size: sizeForCart,
          color: colorFinal,
          price: finalPrice
        });
      }

      if (multiData && multiData.isMulti) {
        const nextIndex = Number(multiData.multiIndex) + 1;
        const hasNext = nextIndex < multiData.multiQueue.length;

        if (hasNext) {
          const nextItem = multiData.multiQueue[nextIndex];
          multiData.multiIndex = nextIndex;
          const nextProduct = await prisma.product.findUnique({ where: { id: nextItem.productId } });

          const preSize = nextItem.size || null;
          const preColor = nextItem.color || null;
          const nextNeedsSize = nextItem.needsSize || (nextProduct && nextProduct.sizes && nextProduct.sizes.length > 0 && !preSize);
          const nextNeedsColor = nextItem.needsColor || (nextProduct && nextProduct.colors && nextProduct.colors.length > 0 && !preColor);

          const nextStep = nextNeedsSize ? 'CONFIRM_SIZE' : (nextNeedsColor ? 'CONFIRM_COLOR' : 'CONFIRM_SIZE');

          await prisma.userSession.update({
            where: { phone: from },
            data: {
              step: nextStep,
              cartJson: JSON.stringify(cart),
              currentProdId: nextItem.productId,
              currentSize: preSize,
              currentColor: preColor,
              tempData: JSON.stringify(multiData)
            }
          });

          if (!nextNeedsSize && !nextNeedsColor) {
            autoAddNextLoop: {
              const session2 = await prisma.userSession.findUnique({ where: { phone: from } });
              const product2 = await prisma.product.findUnique({ where: { id: session2.currentProdId } });
              if (product2) {
                const hasColors2 = product2.colors && product2.colors.length > 0;
                if (hasColors2 && !session2.currentColor) break autoAddNextLoop;
                const colorFinal2 = session2.currentColor;
                let finalPrice2 = Number(product2.price);
                if (product2.promoType === 'PERCENTAGE' && product2.discountPercent > 0) {
                  finalPrice2 = finalPrice2 - (finalPrice2 * (product2.discountPercent / 100));
                }
                const multiData2 = JSON.parse(session2.tempData);
                const qty2 = Math.max(1, Number(multiData2.multiQueue[multiData2.multiIndex].qty) || 1);
                for (let i = 0; i < qty2; i++) {
                  cart.push({ productId: product2.id, name: product2.name, size: session2.currentSize, color: colorFinal2, price: finalPrice2 });
                }
                const nextIndex2 = Number(multiData2.multiIndex) + 1;
                if (nextIndex2 < multiData2.multiQueue.length) {
                  multiData2.multiIndex = nextIndex2;
                  const next2 = multiData2.multiQueue[nextIndex2];
                  const nextProd2 = await prisma.product.findUnique({ where: { id: next2.productId } });
                  const pre2Size = next2.size;
                  const pre2Color = next2.color;
                  const next2Step = 'CONFIRM_SIZE';
                  await prisma.userSession.update({
                    where: { phone: from },
                    data: {
                      step: next2Step,
                      cartJson: JSON.stringify(cart),
                      currentProdId: next2.productId,
                      currentSize: pre2Size,
                      currentColor: pre2Color,
                      tempData: JSON.stringify(multiData2),
                    }
                  });
                  if (!next2.needsSize && !next2.needsColor) {
                    const nc = multiData2;
                    const queueItems = multiData2.multiQueue;
                    let curIdx = nextIndex2;
                    let curSize = pre2Size;
                    let curColor = pre2Color;
                    let curProd = nextProd2;
                    while (curIdx < queueItems.length && !queueItems[curIdx].needsSize && !queueItems[curIdx].needsColor && curProd) {
                      const item = queueItems[curIdx];
                      const pr = curProd;
                      let fp3 = Number(pr.price);
                      if (pr.promoType === 'PERCENTAGE' && pr.discountPercent > 0) fp3 -= fp3 * pr.discountPercent / 100;
                      const q3 = Math.max(1, Number(item.qty) || 1);
                      for (let i = 0; i < q3; i++) cart.push({ productId: pr.id, name: pr.name, size: curSize, color: curColor, price: fp3 });
                      curIdx++;
                      if (curIdx >= queueItems.length) break;
                      const nxt = queueItems[curIdx];
                      nc.multiIndex = curIdx;
                      curSize = nxt.size; curColor = nxt.color;
                      curProd = await prisma.product.findUnique({ where: { id: nxt.productId } });
                      if (!nxt.needsSize || nxt.needsColor) {
                        await prisma.userSession.update({
                          where: { phone: from },
                          data: {
                            step: nxt.needsSize ? 'CONFIRM_SIZE' : (nxt.needsColor ? 'CONFIRM_COLOR' : 'CONFIRM_SIZE'),
                            cartJson: JSON.stringify(cart),
                            currentProdId: nxt.productId,
                            currentSize: curSize,
                            currentColor: curColor,
                            tempData: JSON.stringify(nc)
                          }
                        });
                        break autoAddNextLoop;
                      }
                    }
                    if (curIdx >= queueItems.length) {
                      let subtotal = cart.reduce((s, it) => s + Number(it.price), 0);
                      const fmtSub = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(subtotal);
                      const resumen = cart.length ? cart.map((it, i) => `${i + 1}. *${it.name}* (Talle ${it.size}, Color ${it.color})`).join('\n') : '';
                      const savedShipping = session.shippingAddr || null;
                      if (savedShipping && savedShipping.trim().length > 3) {
                        await prisma.userSession.update({ where: { phone: from }, data: { step: 'CONFIRM_RECIPIENT', cartJson: JSON.stringify(cart), currentProdId: null, currentSize: null, currentColor: null, tempData: null } });
                        return client.sendMessage(from,
                          `✅ *Todos los productos confirmados!* (${cart.length} unidades)\n\n` +
                          (resumen ? `📋 Resumen:\n${resumen}\n\n` : '') +
                          `💰 *Subtotal: ${fmtSub}*\n📍 *Envío a:* ${savedShipping}\n\n👤 ¿A *nombre de quién* hay que entregar el pedido? (Nombre y Apellido):`
                        );
                      }
                      await prisma.userSession.update({ where: { phone: from }, data: { step: 'CONFIRM_SHIPPING', cartJson: JSON.stringify(cart), currentProdId: null, currentSize: null, currentColor: null, tempData: null } });
                      return client.sendMessage(from, `✅ *Todos los productos confirmados!* (${cart.length} unidades)\n\n${resumen ? `📋 Resumen:\n${resumen}\n\n` : ''}💰 *Subtotal: ${fmtSub}*\n\nAhora ingresa tu *dirección completa de envío* (Calle, Número, Ciudad):`);
                    }
                  } else {
                    let subtotal = cart.reduce((s, it) => s + Number(it.price), 0);
                    const fmtSub = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(subtotal);
                    const resumen = cart.length ? cart.map((it, i) => `${i + 1}. *${it.name}* (Talle ${it.size}, Color ${it.color})`).join('\n') : '';
                    const savedShipping = session.shippingAddr || null;
                    if (savedShipping && savedShipping.trim().length > 3) {
                      await prisma.userSession.update({ where: { phone: from }, data: { step: 'CONFIRM_RECIPIENT', cartJson: JSON.stringify(cart), currentProdId: null, currentSize: null, currentColor: null, tempData: null } });
                      return client.sendMessage(from, `✅ *Todos los productos confirmados!* (${cart.length} unidades)\n\n${resumen ? `📋 Resumen:\n${resumen}\n\n` : ''}💰 *Subtotal: ${fmtSub}*\n📍 *Envío a:* ${savedShipping}\n\n👤 ¿A *nombre de quién* hay que entregar el pedido? (Nombre y Apellido):`);
                    }
                    await prisma.userSession.update({ where: { phone: from }, data: { step: 'CONFIRM_SHIPPING', cartJson: JSON.stringify(cart), currentProdId: null, currentSize: null, currentColor: null, tempData: null } });
                    return client.sendMessage(from, `✅ *Todos los productos confirmados!* (${cart.length} unidades)\n\n${resumen ? `📋 Resumen:\n${resumen}\n\n` : ''}💰 *Subtotal: ${fmtSub}*\n\nAhora ingresa tu *dirección completa de envío* (Calle, Número, Ciudad):`);
                  }
                }
              }
            }
          }

          const nextCaption =
            `✅ *${product.name}* × ${qtyForCurrent} agregado/a correctamente.\n\n` +
            `Siguiente producto (${nextIndex + 1}/${multiData.multiQueue.length}):\n` +
            `*${nextProduct ? nextProduct.name : 'Producto'}* × ${nextItem.qty}\n` +
            (preSize ? `📏 Talle precargado: *${preSize}*\n` : '') +
            (preColor ? `🎨 Color precargado: *${preColor}*\n` : '') +
            `\nPor favor, ${nextNeedsSize
              ? `responde con el *talle / variante* (${nextProduct ? nextProduct.sizes.join(', ') : '...'})`
              : `responde con el *color* (${nextProduct ? nextProduct.colors.join(', ') : '...'})`}:`;

          let nextImg = nextProduct ? ((nextProduct.images && nextProduct.images[0]) || nextProduct.imageUrl) : null;
          if (nextImg) {
            try {
              const baseUrl = process.env.WEB_URL || 'https://kicks-ar.vercel.app/';
              const fullImgUrl = nextImg.startsWith('http')
                ? nextImg
                : `${baseUrl.replace(/\/$/, '')}/${nextImg.replace(/^\//, '')}`;
              const media = await MessageMedia.fromUrl(fullImgUrl, { unsafeMime: true });
              return client.sendMessage(from, media, { caption: nextCaption });
            } catch (e) { console.error('Error img:', e.message); }
          }
          return client.sendMessage(from, nextCaption);

        } else {
          let subtotal = cart.reduce((sum, it) => sum + Number(it.price), 0);
          const fmtSub = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(subtotal);
          let resumen = cart.length ? cart.map((it, i) => `${i + 1}. *${it.name}* (Talle ${it.size}, Color ${it.color})`).join('\n') : '';
          const savedShipping = session.shippingAddr || null;

          if (savedShipping && savedShipping.trim().length > 3) {
            await prisma.userSession.update({
              where: { phone: from },
              data: {
                step: 'CONFIRM_RECIPIENT',
                cartJson: JSON.stringify(cart),
                currentProdId: null,
                currentSize: null,
                currentColor: null,
                tempData: null
              }
            });
            return client.sendMessage(from,
              `✅ *Todos los productos confirmados!* (${cart.length} unidades)\n\n` +
              `${resumen ? `📋 Resumen:\n${resumen}\n\n` : ''}` +
              `💰 *Subtotal: ${fmtSub}*\n` +
              `📍 *Envío a:* ${savedShipping}\n\n` +
              `👤 Ahora ¿A *nombre de quién* hay que entregar el pedido? (Nombre y Apellido del destinatario):`
            );
          }

          await prisma.userSession.update({
            where: { phone: from },
            data: {
              step: 'CONFIRM_SHIPPING',
              cartJson: JSON.stringify(cart),
              currentProdId: null,
              currentSize: null,
              currentColor: null,
              tempData: null
            }
          });

          return client.sendMessage(from,
            `✅ *Todos los productos confirmados!* (${cart.length} unidades)\n\n` +
            `${resumen ? `📋 Resumen:\n${resumen}\n\n` : ''}` +
            `💰 *Subtotal: ${fmtSub}*\n\n` +
            `Ahora ingresa tu *dirección completa de envío* (Calle, Número, Ciudad):`
          );
        }
      }
      // ---------- FIN LÓGICA DE CARRITO MÚLTIPLE ----------

      cart.push({
        productId: product.id,
        name: product.name,
        size: session.currentSize,
        color: colorFinal,
        price: finalPrice
      });

      await prisma.userSession.update({
        where: { phone: from },
        data: { 
          step: 'ASK_MORE_PRODUCTS', 
          cartJson: JSON.stringify(cart),
          currentProdId: null,
          currentSize: null,
          currentColor: null
        }
      });

      return client.sendMessage(from, 
        `✅ *¡Producto agregado al carrito!*\n\n` +
        `¿Deseas agregar *otro producto* a tu compra?\n\n` +
        `1. Sí, quiero agregar otro producto\n` +
        `2. No, continuar con los datos de envío y pago\n\n` +
        `Responde con el número *1* o *2*.`
      );
    }

    if (session.step === 'ASK_MORE_PRODUCTS') {
      const option = text.trim();

      if (option === '1' || option.toLowerCase().includes('sí') || option.toLowerCase().includes('si')) {
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'AWAITING_EXTRA_PRODUCT_OR_CONTINUE' }
        });

        const webUrl = process.env.WEB_URL || 'https://kicks-ar.vercel.app/';

        return client.sendMessage(from,
          `🛒 ¡Perfecto! Ingresa al catálogo web en el siguiente enlace:\n\n` +
          `👉 ${webUrl}\n\n` +
          `Elige tu siguiente producto y presiona *"Comprar por WhatsApp"* para sumarlo a la lista.\n\n` +
          `_(O responde con la letra *C* para seguir directamente con el pedido si ya no quieres agregar nada más)_`
        );
      } else {
        const savedShipping = session.shippingAddr || null;
        if (savedShipping && savedShipping.trim().length > 3) {
          await prisma.userSession.update({
            where: { phone: from },
            data: { step: 'CONFIRM_RECIPIENT' }
          });
          return client.sendMessage(from,
            `Anotado.\n📍 *Envío a:* ${savedShipping}\n\n👤 ¿A *nombre de quién* hay que entregar el pedido? (Nombre y Apellido del destinatario):`
          );
        }
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'CONFIRM_SHIPPING' }
        });
        return client.sendMessage(from, 'Anotado. Ingresa tu *dirección completa de envío* (Calle, Número, Ciudad):');
      }
    }

    if (session.step === 'AWAITING_EXTRA_PRODUCT_OR_CONTINUE') {
      if (text.trim().toUpperCase() === 'C') {
        const savedShipping = session.shippingAddr || null;
        if (savedShipping && savedShipping.trim().length > 3) {
          await prisma.userSession.update({
            where: { phone: from },
            data: { step: 'CONFIRM_RECIPIENT' }
          });
          return client.sendMessage(from,
            `Perfecto.\n📍 *Envío a:* ${savedShipping}\n\n👤 ¿A *nombre de quién* hay que entregar el pedido? (Nombre y Apellido):`
          );
        }
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'CONFIRM_SHIPPING' }
        });
        return client.sendMessage(from, 'Anotado. Ingresa tu *dirección completa de envío* (Calle, Número, Ciudad):');
      }
      return client.sendMessage(from,
        `Elige tu nuevo producto desde la web o responde con la letra *C* para continuar con los datos de envío.`
      );
    }

    if (session.step === 'CONFIRM_SHIPPING') {
      await prisma.userSession.update({
        where: { phone: from },
        data: { step: 'CONFIRM_RECIPIENT', shippingAddr: text }
      });
      return client.sendMessage(from, '👤 ¿A *nombre de quién* hay que entregar el pedido? (Nombre y Apellido del destinatario):');
    }

    if (session.step === 'CONFIRM_RECIPIENT') {
      await prisma.userSession.update({
        where: { phone: from },
        data: { step: 'CONFIRM_DELIVERY_OPTION', recipientName: text }
      });

      const menuEntrega = 
        `🚚 *¿Cuándo prefieres recibir tu pedido?*\n\n` +
        `1. Lo antes posible (Envío prioritario)\n` +
        `2. Programar día y franja horaria\n\n` +
        `Responde con el número *1* o *2*.`;

      return client.sendMessage(from, menuEntrega);
    }

    if (session.step === 'CONFIRM_DELIVERY_OPTION') {
      const option = text.trim();

      if (option === '1' || option.toLowerCase().includes('antes') || option.toLowerCase().includes('posible')) {
        await prisma.userSession.update({
          where: { phone: from },
          data: { 
            step: 'CONFIRM_PAYMENT', 
            deliveryOption: 'Lo antes posible',
            deliveryDay: 'Hoy / Lo antes posible',
            deliveryTimeSlot: 'Inmediato'
          }
        });

        let total = cart.reduce((sum, item) => sum + Number(item.price), 0);
        const formattedTotal = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(total);

        let resumenCarrito = cart.map((item, index) => `${index + 1}. *${item.name}* (Talle ${item.size}, Color ${item.color}) - ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(item.price)}`).join('\n');

        const menuPagos = 
          `📋 *Resumen de tu compra (${cart.length} productos):*\n${resumenCarrito}\n\n` +
          `💰 *MONTO TOTAL A PAGAR:* *${formattedTotal}*\n\n` +
          `¿Cuál es tu *medio de pago* preferido?\n\n` +
          `1. Mercado Pago\n` +
          `2. PayPal\n` +
          `3. Transferencia Bancaria\n` +
          `4. Efectivo contra entrega`;

        return client.sendMessage(from, menuPagos);

      } else if (option === '2' || option.toLowerCase().includes('programar')) {
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'CONFIRM_DELIVERY_DETAILS', deliveryOption: 'Programado' }
        });

        return client.sendMessage(from, '📅 Ingresa el *día* y la *franja horaria* en la que podemos entregar tu paquete.\n\n_(Ejemplo: Mañana de 14:00 a 18:00 hs)_');
      } else {
        return client.sendMessage(from, 'Por favor, responde con *1* para recibirlo lo antes posible o *2* para programar la entrega.');
      }
    }

    if (session.step === 'CONFIRM_DELIVERY_DETAILS') {
      await prisma.userSession.update({
        where: { phone: from },
        data: { 
          step: 'CONFIRM_PAYMENT',
          deliveryDay: text,
          deliveryTimeSlot: text
        }
      });

      let total = cart.reduce((sum, item) => sum + Number(item.price), 0);
      const formattedTotal = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(total);

      let resumenCarrito = cart.map((item, index) => `${index + 1}. *${item.name}* (Talle ${item.size}, Color ${item.color}) - ${new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(item.price)}`).join('\n');

      const menuPagos = 
        `📋 *Resumen de tu compra (${cart.length} productos):*\n${resumenCarrito}\n\n` +
        `💰 *MONTO TOTAL A PAGAR:* *${formattedTotal}*\n\n` +
        `¿Cuál es tu *medio de pago* preferido?\n\n` +
        `1. Mercado Pago\n` +
        `2. PayPal\n` +
        `3. Transferencia Bancaria\n` +
        `4. Efectivo contra entrega`;

      return client.sendMessage(from, menuPagos);
    }

    if (session.step === 'CONFIRM_PAYMENT') {
      const option = text.trim();
      const config = await prisma.paymentConfig.findFirst().catch(() => null);

      let paymentMethodName = '';
      let mensajePago = '';
      let linkEnviado = null;

      let total = cart.reduce((sum, item) => sum + Number(item.price), 0);
      const formattedTotal = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(total);

      if (option === '1' || option.toLowerCase().includes('mercado')) {
        paymentMethodName = 'Mercado Pago';
        linkEnviado = config?.mpPaymentLink;
        mensajePago = `💳 *Pago con Mercado Pago*\nPuedes abonar el total de *${formattedTotal}* mediante este link de cobro:\n${linkEnviado || 'Consultar link'}`;
        if (config?.mpQrCodeUrl) {
          try {
            const mediaQr = await MessageMedia.fromUrl(config.mpQrCodeUrl, { unsafeMime: true });
            await client.sendMessage(from, mediaQr, { caption: 'O escaneá este QR con Mercado Pago:' });
          } catch (e) {}
        }
      } else if (option === '2' || option.toLowerCase().includes('paypal')) {
        paymentMethodName = 'PayPal';
        linkEnviado = config?.paypalLink;
        mensajePago = `🌐 *Pago con PayPal*\nPuedes abonar tu orden ingresando aquí:\n${linkEnviado || 'Consultar link'}`;
      } else if (option === '3' || option.toLowerCase().includes('transferencia')) {
        paymentMethodName = 'Transferencia Bancaria';
        mensajePago = `🏦 *Datos Bancarios*\nTotal a transferir: *${formattedTotal}*\nAlias/CBU:\n*${config?.bankAlias || 'Consultar CBU por privado'}*`;
      } else {
        paymentMethodName = 'Efectivo contra entrega (Con Seña)';
        
        const depositAmount = total * DOWN_PAYMENT_PERCENTAGE;
        const formattedDeposit = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(depositAmount);
        const remainingAmount = total - depositAmount;
        const formattedRemaining = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(remainingAmount);

        mensajePago = 
          `💵 *Efectivo contra entrega*\n\n` +
          `Para confirmar y congelar el stock de tu pedido, es necesario abonar una *seña previa del 20%* (${formattedDeposit}).\n` +
          `El saldo restante (*${formattedRemaining}*) lo abonás en efectivo al recibir el paquete.\n\n` +
          `🏦 *Datos para transferir la seña (${formattedDeposit}):*\n` +
          `Alias/CBU: *${config?.bankAlias || 'Consultar CBU por privado'}*`;
      }

      let validUserId = null;
      if (session.userId) {
        const userExists = await prisma.user.findUnique({
          where: { id: session.userId }
        });
        if (userExists) {
          validUserId = userExists.id;
        }
      }

      const order = await prisma.order.create({
        data: {
          phone: from,
          userId: validUserId,
          itemsSummary: JSON.stringify(cart),
          totalAmount: total,
          address: session.shippingAddr,
          recipientName: session.recipientName,
          deliveryOption: session.deliveryOption || 'Lo antes posible',
          deliveryDay: session.deliveryDay || 'Inmediato',
          deliveryTimeSlot: session.deliveryTimeSlot || 'Inmediato',
          payment: paymentMethodName,
          paymentLink: linkEnviado,
          status: 'PENDING_PAYMENT'
        }
      });

      await prisma.userSession.update({
        where: { phone: from },
        data: { step: 'AWAITING_PAYMENT_CONFIRMATION', currentOrderId: order.id }
      });

      await client.sendMessage(from, mensajePago);

      setTimeout(async () => {
        await client.sendMessage(from, '¿Ya realizaste el pago/seña? Responde con la palabra *SI* cuando lo hayas completado.');
      }, 1500);

      return;
    }

    if (session.step === 'AWAITING_PAYMENT_CONFIRMATION') {
      if (text.toLowerCase() === 'si' || text.toLowerCase() === 'sí') {
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'AWAITING_RECEIPT' }
        });
        return client.sendMessage(from, '📸 Por favor, adjunta o envía la *imagen/foto del comprobante de pago o seña* por este medio para confirmar definitivamente tu pedido.');
      } else {
        return client.sendMessage(from, 'Quedamos a la espera. Cuando realices el pago/seña, responde únicamente con la palabra *SI* para adjuntar el comprobante.');
      }
    }

    if (session.step === 'AWAITING_RECEIPT') {
      if (msg.hasMedia) {
        clearInactivityTimer(from);

        const order = await prisma.order.update({
          where: { id: session.currentOrderId },
          data: { 
            status: 'PAYMENT_IN_REVIEW',
            receiptUrl: 'Comprobante Recibido'
          }
        });

        safeDownloadMedia(msg).then(async (receiptDataUrl) => {
          if (receiptDataUrl) {
            await prisma.order.update({
              where: { id: session.currentOrderId },
              data: { receiptUrl: receiptDataUrl }
            }).catch(() => {});
          }
        });

        try {
          const pdfBuffer = await generateOrderPDFBuffer(order);
          const pdfMedia = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), `Resumen_Orden_${order.id.slice(0, 8)}.pdf`);

          await client.sendMessage(from, pdfMedia, { 
            caption: `📄 *Resumen de Compra Generado*\n\n📌 *Estado:* El comprobante está en *proceso de aprobación*.\nTe daremos novedades en un momento en cuanto sea verificado por el equipo.` 
          });
        } catch (pdfErr) {
          console.error('Error enviando PDF:', pdfErr);
          await client.sendMessage(from, `📌 *Estado:* Tu comprobante fue recibido. El pago/seña está en *proceso de aprobación*.`);
        }

        setTimeout(async () => {
          await client.sendMessage(from, '⏳ *Estamos verificando tu comprobante, por favor aguarde un momento.*');
        }, 1200);

        await prisma.userSession.update({
          where: { phone: from },
          data: { 
            step: 'IDLE', 
            cartJson: '[]',
            currentOrderId: null, 
            shippingAddr: null,
            recipientName: null,
            deliveryOption: null,
            deliveryDay: null,
            deliveryTimeSlot: null
          }
        });

        return;
      } else {
        return client.sendMessage(from, 'Por favor, envía el comprobante como una foto o imagen adjunta.');
      }
    }

  } catch (err) {
    console.error('Error procesando mensaje en el bot:', err);
    clearInactivityTimer(from);
    await prisma.userSession.update({
      where: { phone: from },
      data: { step: 'IDLE' }
    }).catch(() => {});
    
    client.sendMessage(from, 'Ocurrió un error al procesar tu solicitud. Por favor intenta iniciar nuevamente enviando un mensaje.');
  }
});

client.initialize();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en el puerto ${PORT}`);
});