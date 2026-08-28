require('dotenv').config();
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

// Instancia de Prisma utilizando variables de entorno protegidas
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
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
      `📩 Consultas o soporte a: *soportekicks@gmail.com*`;

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
      `📩 Soporte: *soportekicks@gmail.com*`;

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
      const webUrl = process.env.WEB_URL || 'http://localhost:3000';
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

    if (session.step === 'IDLE' && !text.includes('quiero comprar el producto')) {
      const option = text.toLowerCase();

      if (option === '1' || option.includes('comprar') || option.includes('compra')) {
        const webUrl = process.env.WEB_URL || 'http://localhost:3000';
        return client.sendMessage(from, 
          `🛒 *Catálogo Online KICKS*\n\n` +
          `Puedes explorar nuestros productos y realizar tu pedido directamente aquí:\n` +
          `👉 ${webUrl}\n\n` +
          `Solo selecciona tu producto y presiona *"Comprar por WhatsApp"*.`
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
                const baseUrl = process.env.WEB_URL || 'http://localhost:3000';
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

    if (session.step === 'RETURN_ASK_ORDER_ID') {
      const cleanOrderId = text.replace('#', '').trim();

      const existingOrder = await prisma.order.findFirst({
        where: { id: { contains: cleanOrderId } }
      });

      if (!existingOrder) {
        return client.sendMessage(from, 
          `⚠️ *Orden no encontrada*\n\n` +
          `No encontramos ningún pedido registrado con el código *"${cleanOrderId}"*.\n` +
          `Por favor, verifica el número de orden e ingrésalo nuevamente:`
        );
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
        return client.sendMessage(from, '🗑️ *Solicitud anulada.* Si deseas operar nuevamente, responde con *MENU* o visita la tienda web.');
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

    // --- CAPTURA DE MENSAJE DE TIENDA (por NOMBRE o por ID) ---
    if (text.includes('quiero comprar el producto')) {
      const match = text.match(/ID:\s*([a-f0-9\-]+)/i);
      const productId = match ? match[1].trim() : null;

      const matchUser = text.match(/USER:\s*([a-f0-9\-]+)/i);
      const userId = matchUser ? matchUser[1].trim() : null;

      let product = null;

      // ESTRATEGIA 1: Si vino el ID, usarlo directamente
      if (productId) {
        product = await prisma.product.findUnique({ where: { id: productId } });
      }

      // ESTRATEGIA 2: Sin ID → detectar nombre del producto y buscar por coincidencia
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

      await prisma.userSession.update({
        where: { phone: from },
        data: { 
          step: 'CONFIRM_SIZE', 
          currentProdId: product.id,
          userId: userId 
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
          const baseUrl = process.env.WEB_URL || 'http://localhost:3000';
          const fullImgUrl = displayImg.startsWith('http') 
            ? displayImg 
            : `${baseUrl.replace(/\/$/, '')}/${displayImg.replace(/^\//, '')}`;

          // ✅ FLAG UNSAFEMIME PARA GARANTIZAR DESCARGA SIN ERRORES DE TIPO MIME
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
      const sizeInput = text.trim().toUpperCase();
      const product = await prisma.product.findUnique({ where: { id: session.currentProdId } });

      if (!product) {
        await prisma.userSession.update({ where: { phone: from }, data: { step: 'IDLE' } });
        return client.sendMessage(from, 'Ocurrió un problema con el producto seleccionado. Por favor, selecciona nuevamente desde la web.');
      }

      const talleEncontrado = product.sizes.find(s => String(s).trim().toUpperCase() === sizeInput);

      if (!talleEncontrado && product.sizes.length > 0) {
        return client.sendMessage(
          from, 
          `⚠️ El talle *"${text}"* no está disponible para este modelo.\n\n` +
          `Por favor, elige uno de los siguientes talles disponibles: *${product.sizes.join(', ')}*`
        );
      }

      const talleFinal = talleEncontrado || text.trim();

      await prisma.userSession.update({
        where: { phone: from },
        data: { step: 'CONFIRM_COLOR', currentSize: talleFinal }
      });

      const coloresDisponibles = product.colors.length > 0 ? product.colors.join(', ') : 'Único';

      return client.sendMessage(
        from, 
        `Perfecto. ¿En qué *color* prefieres tu producto?\n\n` +
        `Colores disponibles: *${coloresDisponibles}*`
      );
    }

    if (session.step === 'CONFIRM_COLOR') {
      const product = await prisma.product.findUnique({ where: { id: session.currentProdId } });

      if (!product) {
        await prisma.userSession.update({ where: { phone: from }, data: { step: 'IDLE' } });
        return client.sendMessage(from, 'Ocurrió un error al buscar el producto. Intenta reiniciar la compra desde la tienda.');
      }

      const colorInput = text.trim().toLowerCase();
      const colorEncontrado = product.colors.find(c => c.trim().toLowerCase() === colorInput);

      if (!colorEncontrado && product.colors.length > 0) {
        return client.sendMessage(
          from, 
          `⚠️ El color *"${text}"* no está disponible para este modelo.\n\n` +
          `Por favor, escribe exactamente uno de los colores disponibles: *${product.colors.join(', ')}*`
        );
      }

      const colorFinal = colorEncontrado || text.trim();

      let finalPrice = Number(product.price);
      if (product.promoType === 'PERCENTAGE' && product.discountPercent > 0) {
        finalPrice = finalPrice - (finalPrice * (product.discountPercent / 100));
      }

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

        const webUrl = process.env.WEB_URL || 'http://localhost:3000';

        return client.sendMessage(from, 
          `🛒 ¡Perfecto! Ingresa al catálogo web en el siguiente enlace:\n\n` +
          `👉 ${webUrl}\n\n` +
          `Elige tu siguiente producto y presiona *"Comprar por WhatsApp"* para sumarlo a la lista.\n\n` +
          `_(O responde con la letra *C* para seguir directamente con el pedido si ya no quieres agregar nada más)_`
        );
      } else {
        await prisma.userSession.update({
          where: { phone: from },
          data: { step: 'CONFIRM_SHIPPING' }
        });
        return client.sendMessage(from, 'Anotado. Ingresa tu *dirección completa de envío* (Calle, Número, Ciudad):');
      }
    }

    if (session.step === 'AWAITING_EXTRA_PRODUCT_OR_CONTINUE') {
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