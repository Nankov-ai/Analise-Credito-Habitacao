import React, { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line } from 'recharts';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { GoogleGenAI, Type } from "@google/genai";
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.4.168/build/pdf.worker.mjs';

// AI instance is created per-call using the user-supplied API key


// --- TYPES ---
interface PaymentPhase {
    duration: number; // in months
    payment: number;
}

interface ProcessingCosts {
    dossierCommission: number;
    propertyValuation: number;
    mortgageRegistration: number;
    otherProcessingCosts: number;
}

interface DeedCosts {
    acquisitionRegistration: number;
    certificates: number;
    solicitorServices: number;
    otherDeedCosts: number;
}

interface Proposal {
  id: number;
  bankName: string;
  purchasePrice: number;
  loanAmount: number;
  propertyValuation: number;
  loanTerm: number;
  interestRateType: 'Variável' | 'Fixa' | 'Mista';
  interestRateText: string;
  lifeInsurance: number;
  homeInsurance: number;
  monthlyPayment: number; // Represents the initial payment
  paymentSchedule: PaymentPhase[]; // Represents the full schedule
  processingCosts: ProcessingCosts;
  deedCosts: DeedCosts;
  tan: number;
  taeg: number;
  taegWithOptionalProducts: number;
}

type ProposalKey = keyof Proposal;

interface ChatMessage {
    sender: 'user' | 'ai';
    text: string;
}

// --- INITIAL DATA & CONFIG ---
const initialProposal: Omit<Proposal, 'id'> = {
  bankName: '',
  purchasePrice: 430000,
  loanAmount: 265000,
  propertyValuation: 430000,
  loanTerm: 30,
  interestRateType: 'Variável',
  interestRateText: 'Euribor(6M) + 0.75%',
  lifeInsurance: 50,
  homeInsurance: 30,
  monthlyPayment: 1000,
  paymentSchedule: [{ duration: 360, payment: 1000 }],
  processingCosts: {
    dossierCommission: 0,
    propertyValuation: 0,
    mortgageRegistration: 0,
    otherProcessingCosts: 0,
  },
  deedCosts: {
    acquisitionRegistration: 0,
    certificates: 0,
    solicitorServices: 0,
    otherDeedCosts: 0,
  },
  tan: 0,
  taeg: 0,
  taegWithOptionalProducts: 0,
};

// Based on the provided image
const exampleProposals: Proposal[] = [];

interface Metric {
  key: string;
  label: string;
  isCurrency?: boolean;
  isHeader?: boolean;
  isSubMetric?: boolean;
  isGrandTotal?: boolean;
}

const metricSections: { title: string; collapsible: boolean; metrics: Metric[] }[] = [
    {
        title: 'Condições Gerais',
        collapsible: false,
        metrics: [
            { key: 'calculated_loan_to_price', label: 'Empréstimo / Preço de compra (%)' },
            { key: 'propertyValuation', label: 'Valor de Avaliação (mínimo)', isCurrency: true },
            { key: 'calculated_ltv', label: 'Valor do empréstimo (LTV) (%)' },
            { key: 'loanTerm', label: 'Prazo de vencimento (anos)' },
        ]
    },
    {
        title: 'Custos Mensais e Seguros',
        collapsible: true,
        metrics: [
            { key: 'monthlyPayment', label: 'Prestação Inicial (capital + juros)', isCurrency: true },
            { key: 'lifeInsurance', label: 'Seguro de vida (mensal)', isCurrency: true },
            { key: 'homeInsurance', label: 'Seguro de habitação (mensal)', isCurrency: true },
            { key: 'calculated_total_monthly', label: 'Encargo Mensal Total (Inicial)', isCurrency: true }
        ]
    },
    {
        title: 'Taxas de Juro',
        collapsible: false,
        metrics: [
            { key: 'interestRateType', label: 'Tipo de taxa de juro' },
            { key: 'interestRateText', label: 'Taxa de juro' },
        ]
    },
    {
        title: 'Custos Iniciais e Taxas',
        collapsible: true,
        metrics: [
            { key: 'calculated_total_processing_costs', label: 'Custos de processo', isCurrency: true, isHeader: true },
            { key: 'processingCosts.dossierCommission', label: 'Comissão de Dossier', isCurrency: true, isSubMetric: true },
            { key: 'processingCosts.propertyValuation', label: 'Custo da Avaliação', isCurrency: true, isSubMetric: true },
            { key: 'processingCosts.mortgageRegistration', label: 'Registo de Hipoteca', isCurrency: true, isSubMetric: true },
            { key: 'processingCosts.otherProcessingCosts', label: 'Outros Custos de Processo', isCurrency: true, isSubMetric: true },
            { key: 'calculated_total_deed_costs', label: 'Custos de escritura (Total)', isCurrency: true, isHeader: true },
            { key: 'deedCosts.acquisitionRegistration', label: 'Registo de Aquisição', isCurrency: true, isSubMetric: true },
            { key: 'deedCosts.certificates', label: 'Certidões', isCurrency: true, isSubMetric: true },
            { key: 'deedCosts.solicitorServices', label: 'Serviços de Solicitadoria', isCurrency: true, isSubMetric: true },
            { key: 'deedCosts.otherDeedCosts', label: 'Outros Custos de Escritura', isCurrency: true, isSubMetric: true },
            { key: 'tan', label: 'TAN (%)' },
            { key: 'taeg', label: 'TAEG (%)' },
            { key: 'taegWithOptionalProducts', label: 'TAEG c/ Vendas Associadas (%)' },
        ]
    },
    {
        title: 'Desembolso Inicial',
        collapsible: false,
        metrics: [
             { key: 'calculated_total_initial_outlay', label: 'Total Desembolso Inicial', isCurrency: true, isHeader: true, isGrandTotal: true },
        ]
    }
];

// --- COMPONENTS ---

const CommonCostsCalculator: React.FC<{ proposals: Proposal[] }> = ({ proposals }) => {
    const purchasePrice = proposals.length > 0 ? proposals[0].purchasePrice : 0;
    const loanAmount = proposals.length > 0 ? proposals[0].loanAmount : 0;
    
    const calculateIMT = (value: number): number => {
        // Tabela de IMT 2024 para Habitação Própria e Permanente (Portugal Continental)
        if (value <= 101917) {
            return 0;
        } else if (value <= 139412) {
            return value * 0.02 - 2038.34;
        } else if (value <= 190794) {
            return value * 0.05 - 6220.70;
        } else if (value <= 317991) {
            return value * 0.07 - 10036.58;
        } else if (value <= 635981) {
            return value * 0.08 - 13216.49;
        } else if (value <= 1102921) {
            return value * 0.06; // Taxa única de 6%
        } else { // Superior a 1.102.921€
            return value * 0.075; // Taxa única de 7.5%
        }
    };

    const imt = useMemo(() => calculateIMT(purchasePrice), [purchasePrice]);
    const stampDutyOnPurchase = useMemo(() => purchasePrice * 0.008, [purchasePrice]);
    const stampDutyOnLoan = useMemo(() => loanAmount * 0.006, [loanAmount]);
    const totalCosts = useMemo(() => imt + stampDutyOnPurchase + stampDutyOnLoan, [imt, stampDutyOnPurchase, stampDutyOnLoan]);

    return (
        <div className="card common-costs-card">
            <div className="card-header">
                <h2>Custos Comuns e Impostos</h2>
            </div>
            <div className="common-costs-content">
                <div className="costs-basis">
                    <h4>Valores Base (da 1ª Proposta)</h4>
                     <ul>
                        <li>
                            <span>Preço de Compra</span>
                            <strong>{purchasePrice.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' })}</strong>
                        </li>
                        <li>
                            <span>Montante do Empréstimo</span>
                            <strong>{loanAmount.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' })}</strong>
                        </li>
                     </ul>
                     <p className="costs-basis-note">Os impostos são calculados com base nos valores da primeira proposta. Edite-os na tabela para atualizar os cálculos.</p>
                </div>
                <div className="costs-results">
                    <h4>Impostos Estimados (Habitação Própria Permanente)</h4>
                    <ul>
                        <li>
                            <span>IMT (Imposto Municipal sobre as Transmissões)</span>
                            <strong>{imt.toFixed(2)}</strong>
                        </li>
                        <li>
                            <span>Imposto de Selo (sobre a compra)</span>
                            <strong>{stampDutyOnPurchase.toFixed(2)}</strong>
                        </li>
                        <li>
                            <span>Imposto de Selo (sobre o crédito)</span>
                            <strong>{stampDutyOnLoan.toFixed(2)}</strong>
                        </li>
                        <li className="total-cost">
                            <span>Total de Impostos</span>
                            <strong>{totalCosts.toFixed(2)}</strong>
                        </li>
                    </ul>
                </div>
            </div>
        </div>
    );
};

const PdfProposalExtractor: React.FC<{ onAddProposal: (extractedData: any) => void; apiKey: string }> = ({ onAddProposal, apiKey }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        if (!apiKey) {
            setError('Introduz uma Gemini API Key nas definições para usar esta funcionalidade.');
            return;
        }

        setIsLoading(true);
        setError('');
        setStatus('');
        let successCount = 0;
        const failedFiles: { name: string, reason: string }[] = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                setStatus(`A processar ficheiro ${i + 1}/${files.length}: ${file.name}...`);
                
                const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = e => resolve(e.target?.result as ArrayBuffer);
                    reader.onerror = () => reject(new Error('Não foi possível ler o ficheiro.'));
                    reader.readAsArrayBuffer(file);
                });

                setStatus(`A ler o PDF (${i + 1}/${files.length})...`);
                const typedArray = new Uint8Array(arrayBuffer);
                const pdf = await pdfjsLib.getDocument(typedArray).promise;
                let fullText = '';
                
                 for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                    const page = await pdf.getPage(pageNum);
                    const textContent = await page.getTextContent();
                    
                    type TextItemWithTransform = { str: string; transform: number[]; width: number; height: number; dir: string; fontName: string; hasEOL: boolean; };
                    const items = textContent.items.filter((item): item is TextItemWithTransform => 
                        'str' in item && 'transform' in item && item.str.trim().length > 0
                    );

                    if (items.length === 0) continue;

                    const Y_TOLERANCE = 5;
                    const lines = new Map<number, TextItemWithTransform[]>();

                    for (const item of items) {
                        const y = item.transform[5];
                        let foundLine = false;
                        for (const lineY of lines.keys()) {
                            if (Math.abs(y - lineY) < Y_TOLERANCE) {
                                lines.get(lineY)!.push(item);
                                foundLine = true;
                                break;
                            }
                        }
                        if (!foundLine) {
                            lines.set(y, [item]);
                        }
                    }

                    const sortedLinesY = Array.from(lines.keys()).sort((a, b) => b - a);
                    let pageText = '';

                    for (const y of sortedLinesY) {
                        const lineItems = lines.get(y)!;
                        lineItems.sort((a, b) => a.transform[4] - b.transform[4]);
                        
                        let lineText = '';
                        if (lineItems.length > 0) {
                            lineText = lineItems[0].str;
                            for (let j = 1; j < lineItems.length; j++) {
                                const prevItem = lineItems[j - 1];
                                const currentItem = lineItems[j];
                                const gap = currentItem.transform[4] - (prevItem.transform[4] + prevItem.width);
                                
                                if (gap > 4) {
                                    const numSpaces = Math.round(gap / 4);
                                    lineText += ' '.repeat(Math.max(1, numSpaces));
                                } else {
                                    lineText += ' ';
                                }
                                lineText += currentItem.str;
                            }
                        }
                        pageText += lineText + '\n';
                    }
                    fullText += pageText + '\n\n';
                }
                
                setStatus(`A extrair dados com IA (${i + 1}/${files.length})...`);
                await extractDataWithAI(fullText);
                successCount++;

            } catch (err: any) {
                console.error(`Falha ao processar ${file.name}:`, err);
                failedFiles.push({ name: file.name, reason: err.message || 'Erro desconhecido' });
            }
        }

        let summaryStatus = '';
        if (successCount > 0) {
            summaryStatus = `Processamento concluído. ${successCount} proposta(s) adicionada(s) com sucesso.`;
        } else {
            summaryStatus = 'Nenhuma proposta foi adicionada.';
        }
        
        if (failedFiles.length > 0) {
            const failedSummary = `Falha ao processar ${failedFiles.length} ficheiro(s): ${failedFiles.map(f => f.name).join(', ')}.`;
            setError(failedSummary);
        }
        
        setStatus(summaryStatus);
        setIsLoading(false);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const extractDataWithAI = async (text: string) => {
        const proposalSchema = {
            type: Type.OBJECT,
            properties: {
                clientName: { type: Type.STRING, description: "Nome completo do(s) proponente(s) ou cliente(s) a quem a proposta se destina. Se houver vários, junte-os com 'e'." },
                bankName: { type: Type.STRING, description: "Nome do banco. Ex: Santander, Bankinter" },
                purchasePrice: { type: Type.NUMBER, description: "Preço de compra do imóvel." },
                loanAmount: { type: Type.NUMBER, description: "Montante do empréstimo solicitado." },
                propertyValuation: { type: Type.NUMBER, description: "Valor da avaliação do imóvel." },
                loanTerm: { type: Type.NUMBER, description: "Prazo do empréstimo em anos." },
                interestRateType: { type: Type.STRING, enum: ['Variável', 'Fixa', 'Mista'], description: "Tipo de taxa de juro." },
                interestRateText: { type: Type.STRING, description: "Descrição completa da taxa de juro. Ex: 'Euribor(6M) + 0.75%' ou '2 anos fixa 2,5%; ...'" },
                lifeInsurance: { type: Type.NUMBER, description: "Custo mensal do seguro de vida." },
                homeInsurance: { type: Type.NUMBER, description: "Custo mensal do seguro de habitação." },
                monthlyPayment: { type: Type.NUMBER, description: "A PRESTAÇÃO MENSAL INICIAL (apenas capital + juros, sem seguros). Corresponde ao valor da primeira fase de pagamento." },
                paymentSchedule: {
                    type: Type.ARRAY,
                    description: "O cronograma completo de pagamentos. Essencial para taxas mistas. Se for uma taxa única, será um array com um único elemento.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            duration: { type: Type.NUMBER, description: "Duração desta fase de pagamento em MESES." },
                            payment: { type: Type.NUMBER, description: "O valor da prestação mensal (capital+juros) para esta fase." }
                        },
                        required: ['duration', 'payment']
                    }
                },
                processingCosts: {
                    type: Type.OBJECT,
                    description: "Detalhes dos custos de processo.",
                    properties: {
                        dossierCommission: { type: Type.NUMBER, description: "Custo da comissão de dossier ou abertura." },
                        propertyValuation: { type: Type.NUMBER, description: "Custo da avaliação do imóvel." },
                        mortgageRegistration: { type: Type.NUMBER, description: "Custo do registo da hipoteca." },
                        otherProcessingCosts: { type: Type.NUMBER, description: "Outros custos diversos de processo." },
                    }
                },
                deedCosts: {
                    type: Type.OBJECT,
                    description: "Detalhes dos custos de escritura. NÃO inclua impostos (IMT, Imposto de Selo) aqui.",
                    properties: {
                        acquisitionRegistration: { type: Type.NUMBER, description: "Custo do registo de aquisição. Se não encontrar, use 0." },
                        certificates: { type: Type.NUMBER, description: "Custo de certidões. Se não encontrar, use 0." },
                        solicitorServices: { type: Type.NUMBER, description: "Custo de serviços de solicitadoria ou notário. Se não encontrar, use 0." },
                        otherDeedCosts: { type: Type.NUMBER, description: "Quaisquer outros custos de escritura não listados acima. NÃO inclua impostos." }
                    }
                },
                tan: { type: Type.NUMBER, description: "TAN (Taxa Anual Nominal) em percentagem. Extraia apenas o número." },
                taeg: { type: Type.NUMBER, description: "TAEG (Taxa Anual de Encargos Efetiva Global) em percentagem. Extraia apenas o número." },
                taegWithOptionalProducts: { type: Type.NUMBER, description: "TAEG com vendas associadas facultativas, se disponível. Extraia apenas o número." },
            },
             required: [
                'bankName', 'loanAmount', 'loanTerm', 'interestRateType', 'interestRateText', 'monthlyPayment', 'paymentSchedule'
            ]
        };

        const prompt = `Você é um analista financeiro especialista em crédito habitação português, com uma precisão impecável. A sua única função é extrair dados de texto de propostas de crédito e formatá-los num JSON. A exatidão é a sua diretiva principal.

**PROTOCOLO DE VERIFICAÇÃO TRIPLA - NÃO NEGOCIÁVEL:**
Antes de gerar a resposta final, é **ABSOLUTAMENTE OBRIGATÓRIO** que execute internamente os seguintes três passos de verificação. Uma falha em seguir este protocolo resultará numa resposta inválida.

**PASSO 1: EXTRAÇÃO E MAPEAMENTO INICIAL**
1.  **Leitura Completa:** Leia o documento na sua totalidade para compreender o contexto.
2.  **Extração de Dados:** Extraia cada valor solicitado pelo esquema JSON. Preste atenção a sinónimos ('Capital em dívida' = 'loanAmount', 'Comissão de Dossier' = 'dossierCommission').
3.  **Nome do Cliente:** Identifique e extraia o nome do(s) proponente(s) para o campo 'clientName'.
4.  **Prazo em Anos:** Se o prazo ('loanTerm') for mencionado em meses (ex: 360), converta-o para anos (30).
5.  **ANÁLISE CRÍTICA - CUSTOS INICIAIS E IMPOSTOS:** É fundamental evitar a dupla contagem de custos. A sua tarefa é separar claramente os custos do banco dos impostos do governo.
    - **Custos do Banco:** Extraia apenas os custos cobrados pelo banco para os campos \`processingCosts\` e \`deedCosts\`.
    - **IMPOSTOS (IMT e Imposto de Selo):** **NUNCA, EM NENHUMA CIRCUNSTÂNCIA, inclua os valores de IMT ou Imposto de Selo nos campos de \`deedCosts\` ou \`processingCosts\`**. A aplicação calcula os impostos separadamente. Se encontrar um valor de "Provisão de Fundos" que mencione impostos, deve subtrair o valor desses impostos antes de preencher os campos. Foque-se em encontrar os valores individuais para \`acquisitionRegistration\`, \`certificates\`, \`solicitorServices\`, e \`otherDeedCosts\`.
6.  **ANÁLISE CRÍTICA - CRONOGRAMA DE PAGAMENTOS (paymentSchedule):**
    Esta é a tarefa mais crítica da sua análise, especialmente para taxas mistas. Uma falha aqui invalida toda a extração.
    - **Identifique TODAS as Fases:** Procure ativamente por frases como "taxa fixa durante X meses", "seguido de taxa variável", "após o período inicial", "nos primeiros Y anos". Cada uma destas frases indica uma fase de pagamento distinta.
    - **Extraia Duração e Prestação:** Para cada fase identificada, extraia a sua duração em **MESES** e o valor exato da prestação mensal (capital+juros).
    - **Exemplo Concreto:** Se o texto diz "A prestação será de 1077,17€ nos primeiros 24 meses e 1135,04€ nos 336 meses seguintes", o seu \`paymentSchedule\` DEVE ser: \`[ { "duration": 24, "payment": 1077.17 }, { "duration": 336, "payment": 1135.04 } ]\`.
    - **REGRA DA PRESTAÇÃO INICIAL:** O campo principal \`monthlyPayment\` DEVE ser **obrigatoriamente** o valor da primeira fase do cronograma. No exemplo acima, \`monthlyPayment\` seria \`1077.17\`.

**PASSO 2: AUDITORIA DE LÓGICA E VERIFICAÇÃO CRUZADA**
Agora, reveja os dados extraídos no Passo 1 e valide-os contra a lógica financeira e o contexto do documento.
1.  **REGRA DE OURO (TAN vs TAEG):** A TAEG inclui a TAN mais outros encargos. Portanto, a **TAEG deve ser SEMPRE maior ou igual à TAN**. Verifique isto. Se a sua extração inicial violar esta regra, é porque cometeu um erro. Volte ao texto e corrija os valores. É um erro comum trocar os dois; não o cometa.
2.  **Valores Plausíveis:** Os valores extraídos são razoáveis? Uma comissão de dossier de 5000€ é provável? Um seguro de vida de 500€/mês para um empréstimo de 200k€ é normal? Use o bom senso financeiro para detetar anomalias. Se um valor parecer estranho, verifique-o novamente no texto original.
3.  **Consistência de Dados:** O nome do banco é consistente? A soma das durações no \`paymentSchedule\` corresponde aproximadamente ao \`loanTerm\` total em meses? (Ex: \`loanTerm\` de 30 anos = 360 meses. A soma das durações no \`paymentSchedule\` deve ser 360). Verifique esta matemática.

**PASSO 3: VALIDAÇÃO FINAL DE FORMATO E INTEGRIDADE**
Esta é a última verificação. A sua saída DEVE ser um JSON perfeito.
1.  **Formato Numérico Estrito:** TODOS os campos numéricos DEVEM conter apenas números (dígitos e, opcionalmente, um ponto decimal). Remova completamente símbolos de moeda (€), percentagens (%), espaços, ou separadores de milhares.
    - **CORRETO:** \`4.5\`, \`1234.56\`, \`500\`
    - **INCORRETO:** \`'4,5%'\`, \`'1.234,56 €'\`, \`'500 euros'\`
2.  **Tratamento de Nulos:** Se um campo opcional não for encontrado, use \`0\` para campos numéricos e uma string vazia \`''\` para campos de texto. Não invente dados. É preferível um \`0\` a um valor incorreto.
3.  **JSON Válido:** A sua resposta final deve ser um objeto JSON único, sem qualquer texto, explicação ou formatação markdown antes ou depois.

Apenas após a execução rigorosa destes três passos, processe o texto abaixo.

Texto da proposta:
---
${text}
---

A sua resposta final deve ser UM ÚNICO objeto JSON que corresponda exatamente ao esquema. Não inclua texto adicional, explicações ou formatação markdown.`;

        try {
            const ai = new GoogleGenAI({ apiKey });
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: proposalSchema
                }
            });

            const jsonString = response.text.trim();
            const extractedData = JSON.parse(jsonString);
            onAddProposal(extractedData);

        } catch (err: any) {
            console.error("Gemini AI error:", err);
            throw new Error("A IA não conseguiu extrair os dados. Verifique o PDF ou tente novamente.");
        }
    };
    
    return (
        <div className="card pdf-extractor-card">
            <div className="card-header">
                <h2>Extrair Proposta de PDF com IA</h2>
            </div>
            <div className="pdf-extractor-content">
                <p>Poupe tempo. Envie um ou mais ficheiros PDF de propostas de crédito habitação e deixe a IA preencher os dados por si.</p>
                <input 
                    type="file" 
                    id="pdf-upload" 
                    accept="application/pdf"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                    ref={fileInputRef}
                    disabled={isLoading}
                    multiple
                />
                <label htmlFor="pdf-upload" className={`button button-primary ${isLoading ? 'disabled' : ''}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20" fill="currentColor"><path d="M453-240h60v-166l64 64 42-42-136-136-136 136 42 42 64-64v166Zm27-142ZM220-80q-24 0-42-18t-18-42v-680q0-24 18-42t42-18h361l219 219v521q0-24-18-42t-42-18H220Zm334-594L773-454H554v-220Z"/></svg>
                    {isLoading ? 'A processar...' : 'Carregar PDF(s)'}
                </label>
                
                <p className="pdf-upload-hint">O PDF deve conter as informações de uma proposta de crédito habitação para que a extração funcione corretamente.</p>
                
                {status && !isLoading && <p className={`status-message ${error ? 'error-summary' : 'success'}`}>{status}</p>}
                {error && <p className="status-message error">{error}</p>}
                {isLoading && <p className="status-message">{status}</p>}

            </div>
        </div>
    );
};

const AutoResizingTextarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = (props) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const { value } = props;

    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (textarea) {
            // Reset height to `auto` to allow browser to calculate natural height
            textarea.style.height = 'auto';
            const scrollHeight = textarea.scrollHeight;
            
            // Set the height to the calculated scrollHeight to fit the content
            textarea.style.height = `${scrollHeight}px`;
        }
    }, [value]); // Rerun effect when the value changes

    return <textarea ref={textareaRef} {...props} value={String(value ?? '')} />;
};


const ComparisonTable: React.FC<{ 
    proposals: Proposal[], 
    ranks: Map<number, number>,
    onUpdate: (id: number, path: string, value: any) => void,
    onDelete: (id: number) => void,
    onAddEmpty: () => void,
    editingProposalId: number | null,
    onSetEditing: (id: number | null) => void,
}> = ({ proposals, ranks, onUpdate, onDelete, onAddEmpty, editingProposalId, onSetEditing }) => {
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    'Custos Mensais e Seguros': false,
    'Taxas de Juro': false, // Now always open by default
    'Custos Iniciais e Taxas': false,
  });

  const handleToggleSection = (title: string) => {
    setCollapsedSections(prev => ({...prev, [title]: !prev[title]}));
  };
  
  const calculateIMT = (value: number): number => {
      if (value <= 101917) return 0;
      if (value <= 139412) return value * 0.02 - 2038.34;
      if (value <= 190794) return value * 0.05 - 6220.70;
      if (value <= 317991) return value * 0.07 - 10036.58;
      if (value <= 635981) return value * 0.08 - 13216.49;
      if (value <= 1102921) return value * 0.06;
      return value * 0.075;
  };

  if (proposals.length === 0) {
    return (
        <div className="card">
            <div className="card-header">
                <h2>Tabela Comparativa</h2>
            </div>
            <div className="empty-state">
                <p>Ainda não adicionou nenhuma proposta.</p>
                <p style={{marginTop: '1rem', fontSize: '0.9rem', color: '#5f6368'}}>Use o extrator de PDF acima para começar.</p>
            </div>
        </div>
    );
  }

  const getNestedValue = (obj: any, path: string) => path.split('.').reduce((o, k) => (o || {})[k], obj);

  const formatDisplayValue = (value: any, isCurrency?: boolean, key?: string) => {
      if (value === null || value === undefined || value === '') return '—';
      if (isCurrency) {
          return Number(value).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
      }
      if (key && (key.toLowerCase().includes('taeg') || key.toLowerCase().includes('tan'))) {
          return `${Number(value).toFixed(2)} %`;
      }
      return String(value);
  };


  return (
    <div className="card">
        <div className="card-header">
            <h2>Tabela Comparativa</h2>
        </div>
        <div className="table-container">
          <table className="comparison-table">
            <thead>
              <tr>
                <th className="metric-header"></th>
                {proposals.map((p, index) => (
                  <th 
                    key={p.id} 
                    className={editingProposalId === p.id ? 'editing-cell' : ''}
                    style={{ backgroundColor: CHART_BACKGROUND_COLORS[index % CHART_BACKGROUND_COLORS.length] }}
                  >
                    <div className="proposal-header">
                        {editingProposalId === p.id ? (
                            <input
                                type="text"
                                value={p.bankName}
                                onChange={e => onUpdate(p.id, 'bankName', e.target.value)}
                                aria-label={`Nome do banco para proposta ${p.id}`}
                                className="bank-name-input"
                            />
                        ) : (
                            <span className="bank-name-display">{p.bankName}</span>
                        )}
                        <div className="proposal-header-actions">
                            <button
                                onClick={() => onSetEditing(editingProposalId === p.id ? null : p.id)}
                                className="button-icon edit"
                                title={editingProposalId === p.id ? 'Concluir edição' : `Editar proposta de ${p.bankName}`}
                                aria-label={editingProposalId === p.id ? 'Concluir edição' : `Editar proposta de ${p.bankName}`}
                            >
                                {editingProposalId === p.id
                                    ? <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20" fill="currentColor"><path d="m424-296 282-282-56-56-226 226-114-114-56 56 170 170Zm56 216q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5-156T763-197q-54 54-127 85.5T480-80Z"/></svg>
                                    : <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20" fill="currentColor"><path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/></svg>
                                }
                            </button>
                            <button 
                                onClick={() => onDelete(p.id)} 
                                className="button-icon delete" 
                                title={`Remover proposta de ${p.bankName}`}
                                aria-label={`Remover proposta de ${p.bankName}`}
                            >
                                &times;
                            </button>
                        </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
                <tr className="section-header-row non-collapsible">
                    <th colSpan={proposals.length + 1}>
                        <div className="section-header-content">
                            Dados da Simulação
                        </div>
                    </th>
                </tr>
                <tr>
                    <td className="metric-header">Preço de compra (€)</td>
                    {proposals.map((p, index) => {
                        const isEditing = editingProposalId === p.id;
                        return (
                            <td key={p.id} className={isEditing ? 'editing-cell' : ''} style={{ backgroundColor: CHART_BACKGROUND_COLORS[index % CHART_BACKGROUND_COLORS.length] }}>
                                {isEditing ? (
                                    <input
                                        type="number"
                                        value={p.purchasePrice}
                                        onChange={e => onUpdate(p.id, 'purchasePrice', parseFloat(e.target.value) || 0)}
                                        aria-label={`Preço de compra para ${p.bankName}`}
                                    />
                                ) : (
                                    <div className="display-value">
                                        {formatDisplayValue(p.purchasePrice, true)}
                                    </div>
                                )}
                            </td>
                        );
                    })}
                </tr>
                <tr>
                    <td className="metric-header">Montante do Empréstimo (€)</td>
                    {proposals.map((p, index) => {
                        const isEditing = editingProposalId === p.id;
                        return (
                            <td key={p.id} className={isEditing ? 'editing-cell' : ''} style={{ backgroundColor: CHART_BACKGROUND_COLORS[index % CHART_BACKGROUND_COLORS.length] }}>
                                {isEditing ? (
                                    <input
                                        type="number"
                                        value={p.loanAmount}
                                        onChange={e => onUpdate(p.id, 'loanAmount', parseFloat(e.target.value) || 0)}
                                        aria-label={`Montante do empréstimo para ${p.bankName}`}
                                    />
                                ) : (
                                    <div className="display-value">
                                        {formatDisplayValue(p.loanAmount, true)}
                                    </div>
                                )}
                            </td>
                        );
                    })}
                </tr>
            </tbody>
            <tbody>
                <tr className="rank-row">
                    <td className="metric-header">Rank</td>
                    {proposals.map((p, index) => {
                        const rank = ranks.get(p.id);
                        return (
                            <td key={p.id} className={`rank-cell rank-${rank}`} style={{ backgroundColor: CHART_BACKGROUND_COLORS[index % CHART_BACKGROUND_COLORS.length] }}>
                                {rank}
                            </td>
                        );
                    })}
                </tr>
            </tbody>
            {metricSections.map(section => (
                <tbody key={section.title}>
                    <tr 
                        className={`section-header-row ${section.collapsible ? 'collapsible' : ''}`}
                        onClick={() => section.collapsible && handleToggleSection(section.title)}
                        aria-expanded={!collapsedSections[section.title]}
                    >
                        <th colSpan={proposals.length + 1}>
                            <div className="section-header-content">
                                {section.title}
                                {section.collapsible && (
                                    <span className={`toggle-icon ${collapsedSections[section.title] ? 'collapsed' : ''}`}>
                                        ▼
                                    </span>
                                )}
                            </div>
                        </th>
                    </tr>
                    {(!section.collapsible || !collapsedSections[section.title]) && section.metrics.map(({ key, label, isCurrency, isHeader, isSubMetric, isGrandTotal }) => {
                        const isCalculated = key.startsWith('calculated_');

                        if (isCalculated) {
                            return (
                                <tr key={key}>
                                    <td className={`metric-header ${isHeader ? 'total-metric-header' : ''} ${isGrandTotal ? 'grand-total-header' : ''}`}>{label}</td>
                                    {proposals.map((p, index) => {
                                        let calculatedValue: string | number = 0;
                                        if (key === 'calculated_loan_to_price') {
                                            const ratio = p.purchasePrice > 0 ? (p.loanAmount / p.purchasePrice) * 100 : 0;
                                            calculatedValue = `${ratio.toFixed(2)} %`;
                                        } else if (key === 'calculated_ltv') {
                                            const ratio = p.propertyValuation > 0 ? (p.loanAmount / p.propertyValuation) * 100 : 0;
                                            calculatedValue = `${ratio.toFixed(2)} %`;
                                        } else if (key === 'calculated_total_monthly') {
                                            const total = p.monthlyPayment + p.lifeInsurance + p.homeInsurance;
                                            calculatedValue = total.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
                                        } else if (key === 'calculated_total_processing_costs') {
                                            const { dossierCommission = 0, propertyValuation = 0, mortgageRegistration = 0, otherProcessingCosts = 0 } = p.processingCosts || {};
                                            const total = dossierCommission + propertyValuation + mortgageRegistration + otherProcessingCosts;
                                            calculatedValue = total.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
                                        } else if (key === 'calculated_total_deed_costs') {
                                            const { acquisitionRegistration = 0, certificates = 0, solicitorServices = 0, otherDeedCosts = 0 } = p.deedCosts || {};
                                            const total = acquisitionRegistration + certificates + solicitorServices + otherDeedCosts;
                                            calculatedValue = total.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
                                        } else if (key === 'calculated_total_initial_outlay') {
                                            const { dossierCommission = 0, propertyValuation = 0, mortgageRegistration = 0, otherProcessingCosts = 0 } = p.processingCosts || {};
                                            const totalProcessing = dossierCommission + propertyValuation + mortgageRegistration + otherProcessingCosts;
                                            
                                            const { acquisitionRegistration = 0, certificates = 0, solicitorServices = 0, otherDeedCosts = 0 } = p.deedCosts || {};
                                            const totalDeed = acquisitionRegistration + certificates + solicitorServices + otherDeedCosts;

                                            const imt = calculateIMT(p.purchasePrice);
                                            const stampDutyOnPurchase = p.purchasePrice * 0.008;
                                            const stampDutyOnLoan = p.loanAmount * 0.006;
                                            const totalTaxes = imt + stampDutyOnPurchase + stampDutyOnLoan;

                                            const totalOutlay = totalProcessing + totalDeed + totalTaxes;
                                            calculatedValue = totalOutlay.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
                                        }
                                        return <td key={p.id} className={`calculated-value ${isHeader ? 'total-metric-value' : ''} ${isGrandTotal ? 'grand-total-value' : ''}`} style={{ backgroundColor: CHART_BACKGROUND_COLORS[index % CHART_BACKGROUND_COLORS.length] }}>{calculatedValue}</td>;
                                    })}
                                </tr>
                            );
                        }

                        return (
                          <tr key={key}>
                            <td className={`metric-header ${isSubMetric ? 'sub-metric-header' : ''}`}>{label}</td>
                            {proposals.map((p, index) => {
                              const isEditing = editingProposalId === p.id;
                              const value = getNestedValue(p, key);
                              const inputType = typeof value === 'number' ? 'number' : 'text';

                              return (
                                <td key={p.id} className={isEditing ? 'editing-cell' : ''} style={{ backgroundColor: CHART_BACKGROUND_COLORS[index % CHART_BACKGROUND_COLORS.length] }}>
                                  {isEditing ? (
                                    <>
                                      {key === 'interestRateType' ? (
                                        <select value={value as string} onChange={e => onUpdate(p.id, key, e.target.value)}>
                                          <option value="Variável">Variável</option>
                                          <option value="Fixa">Fixa</option>
                                          <option value="Mista">Mista</option>
                                        </select>
                                      ) : key === 'interestRateText' ? (
                                        <AutoResizingTextarea
                                            value={value as string}
                                            onChange={e => onUpdate(p.id, key, e.target.value)}
                                            aria-label={`${label} para ${p.bankName}`}
                                            rows={1}
                                        />
                                      ) : (
                                        <input
                                          type={inputType}
                                          value={value ?? ''}
                                          onChange={e => onUpdate(p.id, key, inputType === 'number' ? parseFloat(e.target.value) || 0 : e.target.value)}
                                          aria-label={`${label} para ${p.bankName}`}
                                          step={inputType === 'number' ? 'any' : undefined}
                                        />
                                      )}
                                    </>
                                  ) : (
                                    <div className="display-value">
                                        {formatDisplayValue(value, isCurrency, key)}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                    })}
                </tbody>
            ))}
             <tfoot>
              <tr>
                <td colSpan={proposals.length + 1} style={{padding: 0, border: 0}}>
                  <button onClick={onAddEmpty} className="button button-add-row">
                    + Adicionar Nova Proposta
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
    </div>
  );
};

const CHART_COLORS = ['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#673AB7', '#00BCD4'];
const CHART_BACKGROUND_COLORS = [
    'rgba(66, 133, 244, 0.08)', 
    'rgba(52, 168, 83, 0.08)', 
    'rgba(251, 188, 5, 0.08)', 
    'rgba(234, 67, 53, 0.08)', 
    'rgba(103, 58, 183, 0.08)', 
    'rgba(0, 188, 212, 0.08)'
];


const DataVisualization: React.FC<{ proposals: Proposal[], clientName: string }> = ({ proposals, clientName }) => {
  const [selectedProposalId, setSelectedProposalId] = useState<number | null>(proposals.length > 0 ? proposals[0].id : null);
  const [lineVisibility, setLineVisibility] = useState<Record<string, boolean>>({});
  
  useEffect(() => {
    if (proposals.length > 0 && !proposals.find(p => p.id === selectedProposalId)) {
        setSelectedProposalId(proposals[0].id);
    }
  }, [proposals, selectedProposalId]);

  useEffect(() => {
    const initialVisibility = proposals.reduce((acc, p) => {
        acc[p.bankName] = true;
        return acc;
    }, {} as Record<string, boolean>);
    setLineVisibility(initialVisibility);
  }, [proposals]);

  const barChartData = useMemo(() => {
    const dataPoint: { [key: string]: number | string } = { category: '' };
    proposals.forEach(p => {
        dataPoint[p.bankName] = p.monthlyPayment + p.lifeInsurance + p.homeInsurance;
    });
    return [dataPoint];
  }, [proposals]);

  const selectedProposal = useMemo(() => {
    return proposals.find(p => p.id === selectedProposalId);
  }, [proposals, selectedProposalId]);

  const pieChartData = useMemo(() => {
    if (!selectedProposal) return [];
    return [
      { name: 'Prestação (Juros+Capital)', value: selectedProposal.monthlyPayment },
      { name: 'Seguro de Vida', value: selectedProposal.lifeInsurance },
      { name: 'Seguro de Habitação', value: selectedProposal.homeInsurance },
    ].filter(item => item.value > 0);
  }, [selectedProposal]);
  
  const getPaymentForMonth = (schedule: PaymentPhase[], month: number): number | null => {
    if (!schedule || schedule.length === 0) return null;
    let cumulativeDuration = 0;
    for (const phase of schedule) {
        cumulativeDuration += phase.duration;
        if (month <= cumulativeDuration) {
            return phase.payment;
        }
    }
    return null; // Month is beyond the total duration
  };

  const lineChartData = useMemo(() => {
    if (proposals.length === 0) return [];

    const maxTermInMonths = Math.max(...proposals.map(p => p.loanTerm || 0)) * 12;
    if (maxTermInMonths === 0) return [];
    
    const changePoints = new Map<number, Set<number>>();
    proposals.forEach(p => {
        const proposalChangePoints = new Set<number>();
        if (p.paymentSchedule && p.paymentSchedule.length > 1) {
            let cumulativeDuration = 0;
            for (let i = 0; i < p.paymentSchedule.length - 1; i++) {
                cumulativeDuration += p.paymentSchedule[i].duration;
                proposalChangePoints.add(cumulativeDuration + 1);
            }
        }
        changePoints.set(p.id, proposalChangePoints);
    });

    const data = [];
    for (let month = 1; month <= maxTermInMonths; month++) {
      const monthData: { [key: string]: any } = { month };

      proposals.forEach(p => {
        const payment = getPaymentForMonth(p.paymentSchedule, month);
        const proposalTermInMonths = (p.loanTerm || 0) * 12;
        
        if (month <= proposalTermInMonths && payment !== null) {
            monthData[p.bankName] = payment + p.lifeInsurance + p.homeInsurance;
            if (changePoints.get(p.id)?.has(month)) {
                monthData[`${p.bankName}_isChangePoint`] = true;
            }
        } else {
             monthData[p.bankName] = null;
        }
      });

      data.push(monthData);
    }
    return data;
  }, [proposals]);

  const handleLegendClick = (data: any) => {
    const { dataKey } = data;
    setLineVisibility(prev => ({ ...prev, [dataKey]: !prev[dataKey] }));
  };
  
  const yAxisDomain = useMemo(() => {
    let maxVal = 0;
    proposals.forEach(p => {
        (p.paymentSchedule || [{payment: p.monthlyPayment}]).forEach(phase => {
            const totalMonthly = (phase.payment || 0) + p.lifeInsurance + p.homeInsurance;
            if (totalMonthly > maxVal) {
                maxVal = totalMonthly;
            }
        });
    });
    return [0, Math.ceil(maxVal * 1.05)]; // Add 5% buffer
  }, [proposals]);

  const handleExportPdf = async () => {
    const chartsContainer = document.getElementById('charts-to-export');
    if (!chartsContainer) {
        console.error("Chart container not found!");
        return;
    }
    const originalTheme = chartsContainer.className;
    chartsContainer.className = 'card light-theme';

    try {
        const canvas = await html2canvas(chartsContainer, { scale: 2, backgroundColor: '#ffffff' });
        const imgData = canvas.toDataURL('image/png');
        
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = pdf.internal.pageSize.getHeight();
        
        const imgProps = pdf.getImageProperties(imgData);
        const imgAspectRatio = imgProps.height / imgProps.width;
        let imgWidth = pdfWidth - 20;
        let imgHeight = imgWidth * imgAspectRatio;

        if (imgHeight > pdfHeight - 30) {
            imgHeight = pdfHeight - 30;
            imgWidth = imgHeight / imgAspectRatio;
        }
        const x = (pdfWidth - imgWidth) / 2;
        pdf.setFontSize(18);
        pdf.text('Análise de Propostas de Crédito', pdfWidth / 2, 15, { align: 'center' });
        if (clientName) {
            pdf.setFontSize(12);
            pdf.text(`Cliente: ${clientName}`, pdfWidth / 2, 22, { align: 'center' });
        }
        pdf.addImage(imgData, 'PNG', x, 30, imgWidth, imgHeight);
        pdf.save(`analise_propostas_${clientName.replace(/\s/g, '_') || 'credito'}.pdf`);

    } catch (error) {
        console.error("Error exporting to PDF:", error);
        alert("Ocorreu um erro ao exportar para PDF.");
    } finally {
       chartsContainer.className = originalTheme;
    }
  };

  if (proposals.length === 0) {
    return null;
  }
  
  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: any[]; label?: string | number }) => {
    if (active && payload && payload.length) {
      return (
        <div className="custom-tooltip">
          <p className="label">{`${payload[0].name}`}</p>
          <p className="intro">{`Encargo Mensal: ${payload[0].value.toFixed(2)} €`}</p>
        </div>
      );
    }
    return null;
  };
  
  const CustomizedDot = (props: any) => {
      const { cx, cy, stroke, payload, dataKey } = props;
      const isChangePoint = payload[`${dataKey}_isChangePoint`];

      if (isChangePoint) {
        return (
          <g>
            <circle cx={cx} cy={cy} r={8} stroke="rgba(255, 255, 255, 0.5)" strokeWidth={3} fill={stroke} />
            <circle cx={cx} cy={cy} r={4} fill="white" />
          </g>
        );
      }

      return null;
  };


  return (
    <div id="charts-to-export" className="card">
      <div className="card-header">
        <h2>Visualização de Dados</h2>
        <button onClick={handleExportPdf} className="button button-secondary">Exportar para PDF</button>
      </div>
        <div className="charts-container">
            <div className="chart-wrapper" id="bar-chart-wrapper">
            <h3>Comparação de Encargo Mensal Total (Inicial)</h3>
            <ResponsiveContainer width="100%" height={300}>
                <BarChart data={barChartData} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="category" hide />
                <YAxis domain={yAxisDomain} tickFormatter={(tick) => tick.toLocaleString('pt-PT', {maximumFractionDigits: 0})}/>
                <Tooltip content={<CustomTooltip />} cursor={{fill: 'rgba(128, 128, 128, 0.1)'}}/>
                <Legend iconType="circle" />
                {proposals.map((p, index) => (
                    <Bar 
                        key={p.id}
                        dataKey={p.bankName}
                        name={p.bankName}
                        fill={CHART_COLORS[index % CHART_COLORS.length]}
                    />
                ))}
                </BarChart>
            </ResponsiveContainer>
            </div>
            <div className="chart-wrapper" id="pie-chart-wrapper">
            <h3>Composição do Encargo Mensal (Inicial)</h3>
            <div className="chart-controls">
                <select
                value={selectedProposalId || ''}
                onChange={(e) => setSelectedProposalId(Number(e.target.value))}
                aria-label="Selecionar proposta para análise de custo"
                >
                {proposals.map(p => (
                    <option key={p.id} value={p.id}>
                    {p.bankName}
                    </option>
                ))}
                </select>
            </div>
            {selectedProposal ? (
                <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                        <Pie
                            data={pieChartData}
                            cx="50%"
                            cy="50%"
                            labelLine={false}
                            outerRadius={80}
                            fill="#8884d8"
                            dataKey="value"
                            nameKey="name"
                            label={({ percent }: any) => `${(percent * 100).toFixed(0)}%`}
                        >
                            {pieChartData.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                            ))}
                        </Pie>
                        <Tooltip formatter={(value) => `${(value as number).toFixed(2)} €`} />
                        <Legend iconType="circle" />
                    </PieChart>
                </ResponsiveContainer>
            ) : (
                <p>Selecione uma proposta para ver a análise.</p>
            )}
            </div>
            <div className="chart-wrapper full-width" id="line-chart-wrapper">
                <h3>Evolução do Encargo Mensal ao Longo do Tempo</h3>
                <ResponsiveContainer width="100%" height={400}>
                    <LineChart
                    data={lineChartData}
                    margin={{
                        top: 5,
                        right: 30,
                        left: 20,
                        bottom: 20,
                    }}
                    >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" label={{ value: 'Meses do Empréstimo', position: 'insideBottom', offset: -10 }} />
                    <YAxis domain={yAxisDomain} label={{ value: 'Encargo Mensal (€)', angle: -90, position: 'insideLeft' }} tickFormatter={(tick) => tick.toLocaleString('pt-PT')} />
                    <Tooltip formatter={(value: number, name: string) => [`${value.toFixed(2)} €`, name]} labelFormatter={(label: string) => `Mês ${label}`} />
                    <Legend onClick={handleLegendClick} verticalAlign="top" wrapperStyle={{ paddingBottom: '20px' }} />
                    {proposals.map((p, index) => (
                        <Line
                        key={p.id}
                        type="monotone"
                        dataKey={p.bankName}
                        name={p.bankName}
                        stroke={CHART_COLORS[index % CHART_COLORS.length]}
                        activeDot={{ r: 6 }}
                        hide={lineVisibility[p.bankName] === false}
                        connectNulls={false}
                        strokeWidth={2}
                        dot={<CustomizedDot />}
                        />
                    ))}
                    </LineChart>
                </ResponsiveContainer>
            </div>
        </div>
    </div>
  );
};

const RepaymentAnalysis: React.FC<{ proposals: Proposal[] }> = ({ proposals }) => {
    if (proposals.length === 0) {
        return null;
    }
    
    const getPaymentForMonth = (schedule: PaymentPhase[], month: number): number | null => {
        if (!schedule || schedule.length === 0) return null;
        let cumulativeDuration = 0;
        for (const phase of schedule) {
            cumulativeDuration += phase.duration;
            if (month <= cumulativeDuration) {
                return phase.payment;
            }
        }
        return null; // Month is beyond the total duration
    };

    const maxTermInMonths = useMemo(() => {
        if (proposals.length === 0) return 0;
        const maxYears = Math.max(...proposals.map(p => p.loanTerm || 0));
        return maxYears * 12;
    }, [proposals]);

    const months = useMemo(() => {
        return Array.from({ length: maxTermInMonths }, (_, i) => i + 1);
    }, [maxTermInMonths]);

    return (
        <div className="card">
            <div className="card-header">
                <h2>Prestação Mensal</h2>
            </div>
            <div className="repayment-analysis-container">
                {maxTermInMonths > 0 ? (
                    <table className="repayment-table">
                        <thead>
                            <tr>
                                <th>Mês</th>
                                {proposals.map(p => (
                                    <th key={p.id}>{p.bankName}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {months.map(month => (
                                <tr key={month}>
                                    <td>{month}</td>
                                    {proposals.map(p => {
                                        const payment = getPaymentForMonth(p.paymentSchedule, month);
                                        const proposalTermInMonths = (p.loanTerm || 0) * 12;
                                        return (
                                            <td key={p.id}>
                                                {month <= proposalTermInMonths && payment !== null ? payment.toFixed(2) : '—'}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div className="empty-state minimal">
                        <p>Adicione um prazo de empréstimo às propostas para ver a análise de reembolso.</p>
                    </div>
                )}
            </div>
        </div>
    );
};

const Chat: React.FC<{ proposals: Proposal[]; onClose: () => void; apiKey: string }> = ({ proposals, onClose, apiKey }) => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView
({ behavior: 'smooth' });
    }, [messages]);

    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMessage: ChatMessage = { sender: 'user', text: input };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        try {
            const prompt = `É um assistente financeiro prestável. Analise os dados da proposta de crédito habitação fornecida para responder às perguntas do utilizador. As suas respostas devem basear-se apenas nos dados fornecidos. Seja amigável e claro. Todos os valores monetários estão em Euros (€). Fale em Português.

Dados das Propostas:
${JSON.stringify(proposals, null, 2)}

Pergunta do Utilizador:
${input}`;
            
            const ai = new GoogleGenAI({ apiKey });
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });
            const text = response.text;
            
            const aiMessage: ChatMessage = { sender: 'ai', text: text };
            setMessages(prev => [...prev, aiMessage]);

        } catch (error: any) {
            console.error("Error calling Gemini API:", error);
            const errorText = "Desculpe, ocorreu um erro ao contactar o assistente. Por favor, tente novamente mais tarde.";
            const errorMessage: ChatMessage = { sender: 'ai', text: errorText };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };
    
    return (
        <div className="chat-modal-overlay" onClick={onClose}>
            <div className="chat-modal-content" onClick={e => e.stopPropagation()}>
                <div className="chat-header">
                    <h3>Converse com Gemini</h3>
                    <button onClick={onClose} className="button-icon close">&times;</button>
                </div>
                <div className="chat-messages">
                    <div className="chat-message ai-message">
                        <p>Olá! Sou o seu assistente Gemini. Como posso ajudar a analisar estas propostas de crédito hoje?</p>
                    </div>
                    {messages.map((msg, index) => (
                        <div key={index} className={`chat-message ${msg.sender}-message`}>
                            <p>{msg.text}</p>
                        </div>
                    ))}
                    {isLoading && (
                        <div className="chat-message ai-message">
                            <div className="typing-indicator">
                                <span></span><span></span><span></span>
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>
                <form onSubmit={handleSendMessage} className="chat-input-form">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Qual a proposta mais barata?"
                        disabled={isLoading}
                        aria-label="Faça uma pergunta sobre as propostas"
                    />
                    <button type="submit" disabled={isLoading || !input.trim()}>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path>
                        </svg>
                    </button>
                </form>
            </div>
        </div>
    );
};


// --- MAIN APP COMPONENT ---
const App = () => {
  const [proposals, setProposals] = useState<Proposal[]>(exampleProposals);
  const [clientName, setClientName] = useState('');
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [editingProposalId, setEditingProposalId] = useState<number | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);


  const ranks = useMemo(() => {
    if (proposals.length === 0) {
        return new Map<number, number>();
    }

    const sorted = [...proposals]
        .map(p => ({
            id: p.id,
            totalMonthly: p.monthlyPayment + p.lifeInsurance + p.homeInsurance,
            taeg: p.taeg,
        }))
        .sort((a, b) => {
            // Primary sort: lowest total monthly cost
            if (a.totalMonthly !== b.totalMonthly) {
                return a.totalMonthly - b.totalMonthly;
            }
            // Secondary sort: lowest TAEG
            return a.taeg - b.taeg;
        });

    const rankMap = new Map<number, number>();
    sorted.forEach((p, index) => {
        rankMap.set(p.id, index + 1);
    });

    return rankMap;
  }, [proposals]);

  const handleAddProposal = (extractedData: any) => {
    if (proposals.length === 0 && extractedData.clientName) {
        setClientName(extractedData.clientName);
    }
    const newProposal: Proposal = {
      ...initialProposal,
      ...extractedData,
      processingCosts: {
        ...initialProposal.processingCosts,
        ...(extractedData.processingCosts || {})
      },
      deedCosts: {
        ...initialProposal.deedCosts,
        ...(extractedData.deedCosts || {})
      },
      paymentSchedule: extractedData.paymentSchedule?.length > 0 
          ? extractedData.paymentSchedule 
          : [{ duration: (extractedData.loanTerm || 30) * 12, payment: extractedData.monthlyPayment || 0 }],
      id: Date.now()
    };
    setProposals(prev => [...prev, newProposal]);
  };

  const handleAddEmptyProposal = () => {
    const newProposal: Proposal = {
      ...initialProposal,
      bankName: `Proposta ${proposals.length + 1}`,
      id: Date.now(),
    };
    setProposals(prev => [...prev, newProposal]);
  };

  const handleUpdateProposal = (id: number, path: string, value: any) => {
    setProposals(prev =>
        prev.map(p => {
            if (p.id === id) {
                // Deep copy to avoid mutation issues.
                const newP = JSON.parse(JSON.stringify(p)); 

                const keys = path.split('.');
                const lastKey = keys.pop()!;
                const target = keys.reduce((obj, key) => obj[key], newP);
                
                target[lastKey] = value;
                
                // If monthlyPayment is updated, also update the first phase of paymentSchedule
                if (path === 'monthlyPayment') {
                    if (newP.paymentSchedule && newP.paymentSchedule.length > 0) {
                        newP.paymentSchedule[0].payment = value;
                    } else {
                        newP.paymentSchedule = [{ duration: (newP.loanTerm || 30) * 12, payment: value }];
                    }
                }
                
                return newP;
            }
            return p;
        })
    );
  };
  
  const handleDeleteProposal = (id: number) => {
      if (id === editingProposalId) {
          setEditingProposalId(null);
      }
      setProposals(prev => prev.filter(p => p.id !== id));
  }

  return (
    <>
        <div className="container">
            <header>
                <div className="client-name-container">
                    <label htmlFor="clientName">Cliente:</label>
                    <input 
                        type="text" 
                        id="clientName" 
                        value={clientName} 
                        onChange={e => setClientName(e.target.value)} 
                        placeholder="Nome do Cliente"
                    />
                </div>
                <h1 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <img src={import.meta.env.BASE_URL + 'nodeflow_icon.svg'} alt="Nodeflow" style={{ height: '28px', width: '28px' }} />
                  Analisador de Propostas de Crédito Habitação
                </h1>
                <p>Adicione e compare propostas de diferentes bancos. Todos os valores na tabela são editáveis para que possa ajustar e simular.</p>
                <div style={{ marginTop: '0.75rem' }}>
                  {!showApiKeyInput && (
                    <button
                      onClick={() => setShowApiKeyInput(true)}
                      style={{ fontSize: '0.75rem', padding: '0.3rem 0.8rem', cursor: 'pointer', opacity: 0.7 }}
                    >
                      {apiKey ? '🔑 API Key configurada' : '🔑 Configurar Gemini API Key (para leitura de PDF e chat IA)'}
                    </button>
                  )}
                  {showApiKeyInput && (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="password"
                        placeholder="Cole aqui a sua Gemini API Key"
                        value={apiKey}
                        onChange={e => setApiKey(e.target.value)}
                        style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem', width: '320px', maxWidth: '100%' }}
                      />
                      <button onClick={() => setShowApiKeyInput(false)} style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem', cursor: 'pointer' }}>
                        {apiKey ? 'Guardar' : 'Cancelar'}
                      </button>
                    </div>
                  )}
                </div>
            </header>
            <main>
                <CommonCostsCalculator proposals={proposals} />
                <PdfProposalExtractor onAddProposal={handleAddProposal} apiKey={apiKey} />
                <ComparisonTable 
                    proposals={proposals} 
                    ranks={ranks} 
                    onUpdate={handleUpdateProposal} 
                    onDelete={handleDeleteProposal} 
                    onAddEmpty={handleAddEmptyProposal}
                    editingProposalId={editingProposalId}
                    onSetEditing={setEditingProposalId}
                />
                <DataVisualization proposals={proposals} clientName={clientName} />
                <RepaymentAnalysis proposals={proposals} />
            </main>
        </div>

        <button className="chat-fab" onClick={() => setIsChatOpen(true)} title="Converse com Gemini" aria-label="Abrir chat com assistente Gemini">
             <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
                <path d="M130-438q-19-9-29.5-27.5T90-504q0-23 12-42t32-32l212-96-212-96q-20-13-32-32t-12-42q0-19 10.5-37.5T130-894l720 390-720 390Zm0-60 600-330-600-330v216l274 114-274 114v216Zm0 0v-660 660Z"/>
             </svg>
        </button>

        {isChatOpen && <Chat proposals={proposals} onClose={() => setIsChatOpen(false)} apiKey={apiKey} />}
    </>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);