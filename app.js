require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;

// MUY IMPORTANTE: Permitir que tu Red Privada se comunique con esta vitrina
app.use(cors({
    origin: ['https://appluxnova.com', 'http://localhost:10000'] 
}));
app.use(express.json());

// 1. Mostrar la Vitrina Clonada al público (Mercado Pago verá esto)
app.use(express.static('public'));

// ==========================================================================
// EL MOTOR CAMUFLADO (Recibe de LuxNetwork -> Envía a MP)
// ==========================================================================

app.post('/generar-pago-directo', async (req, res) => {
    try {
        const { monto, clienteEmail, id_carrito, producto, metodoPago } = req.body;

        // 1. Extraemos y desciframos el Token de la Red (Lux2)
        const authHeader = req.headers['authorization'];
        let idDelComprador = "ANONIMO";
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                idDelComprador = decoded.id; // Atrapamos su ID real
            } catch (err) {
                console.log("Token no válido o ausente.");
            }
        }

        if (!monto || !clienteEmail || !metodoPago) {
            return res.status(400).json({ error: "Faltan parámetros requeridos" });
        }

        const montoNumerico = parseFloat(monto);
        const metodoReal = metodoPago === 'yape' ? 'pagoefectivo_atm' : metodoPago;

        console.log(`[Shop Clon] Recibiendo orden secreta. Generando ${metodoReal} por S/ ${montoNumerico}`);

        // Llamada a Mercado Pago INYECTANDO EL ORIGEN FALSO
        const response = await fetch('https://api.mercadopago.com/v1/payments', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`, 
                'Content-Type': 'application/json',
                'X-Idempotency-Key': id_carrito 
            },
            body: JSON.stringify({
                transaction_amount: montoNumerico,
                description: "Recarga de Saldo - Luxnova", // O el nombre del producto que prefieras
                payment_method_id: metodoReal, 
                // Mercado Pago enviará el webhook a esta web clonada
                notification_url: "https://appluxnovashop.com/webhook-mp", 
                payer: {
                    email: clienteEmail,
                    first_name: "Cliente", 
                    last_name: "Shop",
                    identification: { type: "DNI", number: "70000000" }
                },
                metadata: {
                    origen_web: "appluxnovashop.com", 
                    id_carrito: id_carrito,
                    usuario_id_lux: idDelComprador // <--- EL ID SE VA A MP
                }
            })
        });

        const data = await response.json();

        if (response.ok && (data.status === 'pending' || data.status === 'approved')) {
            return res.json({
                exito: true,
                id_pago: data.id,
                ticket_url: data.transaction_details.external_resource_url
            });
        } else {
            console.error("MP rechazó los datos:", data);
            return res.status(400).json({ error: "Mercado Pago rechazó la operación", detalle: data });
        }

    } catch (error) {
        console.error("Error crítico en Clon Shop:", error);
        return res.status(500).json({ error: "Fallo interno en vitrina" });
    }
});

// ==========================================================================
// CHECKOUT NORMAL (Para que la vitrina funcione si el auditor hace una compra)
// ==========================================================================
app.post('/procesar-pago', async (req, res) => {
    try {
        const { monto, clienteEmail, producto } = req.body;

        const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`, 
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                items: [{
                    title: producto || "Producto Luxnova",
                    quantity: 1,
                    unit_price: parseFloat(monto),
                    currency_id: "PEN"
                }],
                payer: { 
                    email: clienteEmail 
                },
                back_urls: {
                    success: "https://appluxnovashop.com/pago-exitoso.html",
                    failure: "https://appluxnovashop.com/pago-fallido.html",
                    pending: "https://appluxnovashop.com/pago-exitoso.html"
                },
                auto_return: "approved"
            })
        });

        const data = await response.json();

        if (response.ok) {
            // Le devolvemos al frontend exactamente el link que está esperando
            res.json({ checkout_url: data.init_point });
        } else {
            console.error("Error al crear preferencia:", data);
            res.status(400).json({ error: "Fallo al crear preferencia" });
        }
    } catch (error) {
        console.error("Error interno del checkout:", error);
        res.status(500).json({ error: "Error en el servidor clon" });
    }
});

// ==========================================================================
// EL PUENTE DE RETORNO (Recibe de MP -> Avisa a tu Red)
// ==========================================================================

app.post('/webhook-mp', async (req, res) => {
    try {
        const { type, data } = req.body;

        if (type === 'payment' && data && data.id) {
            const paymentId = data.id;
            console.log(`[Webhook Shop] Revisando pago ID: ${paymentId}`);

            const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
            });

            const paymentData = await paymentResponse.json();

            if (paymentResponse.ok && paymentData.status === 'approved') {
                const { id_carrito, usuario_id_lux } = paymentData.metadata; 
                const montoAprobado = paymentData.transaction_amount;

                console.log(`[Webhook Shop] ¡PAGO APROBADO! S/ ${montoAprobado}. Avisando a la Red Principal...`);

                // Disparamos una alerta silenciosa al backend de tu RED (appluxnova.com)
                try {
                    await fetch('https://appluxnova.com/api/confirmar-pedido', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                    id_carrito: id_carrito,
                    estado: 'PAGADO',
                    monto: montoAprobado,
                    origen: 'luxpay2',
                    usuario_id_real: usuario_id_lux // <--- REGRESA A LUX NETWORK
                })
                    });
                } catch (err) {
                    console.error("Error al avisar a la Red:", err);
                }
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error("Error en Webhook Shop:", error);
        res.status(200).send('Procesado con errores');
    }
});

app.get(/.*/, (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`✅ Vitrina Clonada LUXNOVA SHOP encendida`);
    console.log(`👉 Haz clic aquí para verla: http://localhost:${port}`);
});