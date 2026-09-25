// Accept offer via OS API v2 (mirrors @opensea/sdk FulfillmentManager.fulfillOrder).
// List: GET /api/v2/offers/collection/{slug}/nfts/{id} -> offers[{order_hash, chain, protocol_address, price{value,decimals,currency}, status}]
// Accept: POST /api/v2/offers/fulfillment_data {offer:{hash,chain,protocolAddress}, fulfiller:{address}, consideration:{assetContractAddress,tokenId}}
//   -> {fulfillment_data:{transaction:{to,value,inputData,function,calldataSuffix}, orders:[...]}}
// Then re-encode inputData with SeaportABI, re-attach calldataSuffix, send raw tx from the seller wallet.
const { ethers } = require('ethers');
const { SeaportABI } = require('@opensea/seaport-js/lib/abi/Seaport');

const API = 'https://api.opensea.io';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FULFILL_BASIC_ORDER_ALIAS = 'fulfillBasicOrder_efficient_6GL6yc';
const NULL_CONDUIT = '0x0000000000000000000000000000000000000000000000000000000000000000';
const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
const SEAPORT_BY_CHAIN = { robinhood: '0x0000000000000068f116a894984e2db1123eb395' };

function fmtOffer(o) {
  const v = Number(o.price.value) / 10 ** o.price.decimals;
  const s = v >= 1 ? v.toFixed(3).replace(/\.?0+$/, '') : v.toFixed(v < 0.01 ? 5 : 4).replace(/\.?0+$/, '');
  return `${s} ${o.price.currency}`;
}

// priceStr shows PER-NFT price (batch criteria orders ask for many NFTs; OS UI shows per-unit too)
function fmtOfferPerUnit(o, nftQty) {
  const total = Number(o.price.value) / 10 ** o.price.decimals;
  const per = nftQty && nftQty > 1n ? total / Number(nftQty) : total;
  const s = per >= 1 ? per.toFixed(3).replace(/\.?0+$/, '') : per.toFixed(per < 0.01 ? 5 : 4).replace(/\.?0+$/, '');
  const totalS = total >= 1 ? total.toFixed(3).replace(/\.?0+$/, '') : total.toFixed(4).replace(/\.?0+$/, '');
  return nftQty && nftQty > 1n ? `${s} ${o.price.currency} (batch ${totalS} × ${nftQty} NFTs)` : `${s} ${o.price.currency}`;
}

// active offers on one token, sorted desc by raw value
async function listOffers(slug, tokenId, apiKey) {
  const j = await fetch(`${API}/api/v2/offers/collection/${slug}/nfts/${tokenId}?limit=50`, {
    headers: { 'x-api-key': apiKey, 'user-agent': UA },
  });
  if (!j.ok) throw new Error(`offers ${j.status}`);
  const res = await j.json();
  return (res.offers || [])
    .filter((o) => o.status === 'ACTIVE' && o.order_hash)
    .map((o) => ({ hash: o.order_hash, chain: o.chain, protocol: o.protocol_address, price: o.price, priceStr: fmtOffer(o) }))
    .sort((a, b) => Number(b.price.value) - Number(a.price.value));
}

// on-chain sanity: offerer must have an allowance to the Seaport exchange >= offer amount, else the
// accept will revert. Returns true when the offer looks executable.
async function offerLooksFundable(provider, offer) {
  const erc20 = new ethers.Contract(offer.token, ['function allowance(address,address) view returns (uint256)'], provider);
  const params = offer.parameters;
  const need = BigInt(params.offer[0].startAmount);
  const offerer = params.offerer;
  const seaport = SEAPORT_BY_CHAIN[offer.chain] || NULL_ADDRESS;
  const allow = await erc20.allowance(offerer, seaport);
  return allow >= need;
}

// enriched offer list: signed order (for offerer + token) + fundable flag
async function listOffersWithOrders(slug, tokenId, apiKey, provider) {
  const offers = await listOffers(slug, tokenId, apiKey);
  for (const o of offers) {
    try {
      const r = await fetch(`${API}/api/v2/orders/chain/${o.chain}/protocol/${o.protocol}/${o.hash}`, { headers: { 'x-api-key': apiKey, 'user-agent': UA } });
      const { order } = await r.json();
      const params = order.protocol_data.parameters;
      o.parameters = params;
      o.token = params.offer[0].token;
      o.nftQty = BigInt(params.consideration[0].startAmount);
      o.priceStr = fmtOfferPerUnit(o, o.nftQty);
      o.fundable = await offerLooksFundable(provider, o);
    } catch {
      o.fundable = null; // unknown, assume ok
    }
  }
  return offers;
}

// build fulfillment payload for accepting the offer (seller = fulfiller)
async function fulfillData(orderHash, chain, protocol, seller, ca, tokenId, bearer, apiKey) {
  const r = await fetch(`${API}/api/v2/offers/fulfillment_data`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      offer: { hash: orderHash, chain, protocol_address: protocol },
      fulfiller: { address: seller },
      consideration: { asset_contract_address: ca, token_id: String(tokenId) },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`fulfillment_data ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const fd = j.fulfillment_data || j.fulfillmentData;
  if (!fd || !fd.transaction) throw new Error('no fulfillment_data in response');
  return fd;
}

// encode the API's inputData into Seaport calldata + attribution suffix (sdk parity)
function encodeFulfillment(fd) {
  const tx = fd.transaction;
  const raw = (tx.function || '').split('(')[0];
  const fn = raw === FULFILL_BASIC_ORDER_ALIAS ? 'fulfillBasicOrder' : raw;
  const input = tx.inputData || tx.input_data;
  const iface = new ethers.Interface(SeaportABI);
  let params;
  if (fn === 'fulfillAdvancedOrder' && input.advancedOrder) {
    params = [input.advancedOrder, input.criteriaResolvers || [], input.fulfillerConduitKey || NULL_CONDUIT, input.recipient];
  } else if ((fn === 'fulfillBasicOrder' || raw === FULFILL_BASIC_ORDER_ALIAS) && input.parameters) {
    params = [input.parameters];
  } else if (fn === 'fulfillOrder' && input.order) {
    params = [input.order, input.fulfillerConduitKey || NULL_CONDUIT];
  } else {
    params = Object.values(input);
  }
  let data = iface.encodeFunctionData(fn, params);
  const suffix = tx.calldataSuffix || tx.calldata_suffix;
  if (suffix && /^0x[0-9a-f]{8}$/i.test(suffix)) data += suffix.slice(2);
  return { to: tx.to, value: BigInt(tx.value || 0), data };
}

// full accept: fulfillData -> encode -> sign -> broadcast -> wait
async function acceptOffer(wallet, offer, ca, tokenId, bearer, apiKey, provider) {
  const fd = await fulfillData(offer.hash, offer.chain, offer.protocol, wallet.address, ca, tokenId, bearer, apiKey);
  const built = encodeFulfillment(fd);
  const [feeData, nonce] = await Promise.all([provider.getFeeData(), provider.getTransactionCount(wallet.address, 'pending')]);
  const tx = { to: built.to, data: built.data, value: built.value, nonce, gasLimit: 500000n, chainId: (await provider.getNetwork()).chainId };
  if (feeData.maxFeePerGas) {
    tx.type = 2;
    tx.maxFeePerGas = feeData.maxFeePerGas;
    tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  } else {
    tx.gasPrice = feeData.gasPrice;
  }
  const signed = await wallet.signTransaction(tx);
  const sent = await provider.broadcastTransaction(signed);
  const receipt = await Promise.race([sent.wait(), new Promise((resolve) => setTimeout(() => resolve(null), 60000))]);
  return { hash: sent.hash, receipt, gasLimit: built.value === 0n ? 'offer pays seller' : 'value>0' };
}

module.exports = { listOffers, listOffersWithOrders, offerLooksFundable, fulfillData, encodeFulfillment, acceptOffer, fmtOffer, fmtOfferPerUnit };
