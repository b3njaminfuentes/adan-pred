// Usa fetch nativo

async function sendShadowTrade() {
  const url = "http://localhost:3000/api/bots/adam/paper-trade";
  
  const payload = {
    // Condition ID real de Polymarket (debe empezar con 0x)
    marketId: "0x34567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12", 
    marketTitle: "¿Ganará Trump las elecciones?",
    side: "YES",
    amount: 150,             // Capital virtual a invertir
    entryPrice: 0.65,       // Probabilidad (precio) calculada por ADAN
    externalTradeId: "adam-trade-5678" // ID único para evitar duplicados
  };

  try {
    console.log("Inyectando trade a Brier Protocol...");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-brier-key": "ef04f7c640377a3aeb89ff16b3ed33bc04c26fe4b939a34a563d65acad5a6360"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log("Respuesta de Brier:", data);
  } catch (err) {
    console.error("Error en la conexión:", err);
  }
}

sendShadowTrade();
