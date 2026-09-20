const { ethers } = require('ethers');
const { OpenSeaSDK, Chain, getDefaultConduit, getSeaportAddress } = require('@opensea/sdk');

const CHAIN_MAP = {
  ethereum: Chain.Mainnet,
  polygon: Chain.Polygon,
  base: Chain.Base,
  robinhood: Chain.Robinhood,
  arc: Chain.Arc,
};

const TWO_DECIMAL_CHAINS = [Chain.Arc, Chain.StableChain];

const ERC721_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

function makeSdk(signerOrProvider, chain, apiKey) {
  return new OpenSeaSDK(signerOrProvider, { chain, apiKey });
}

function parsePriceInput(input, floorPrice) {
  if (!input) {
    return floorPrice * 0.9;
  }
  const trimmed = input.trim();
  if (trimmed.endsWith('%')) {
    const percent = parseFloat(trimmed);
    return floorPrice * (1 + percent / 100);
  }
  return parseFloat(trimmed);
}

function roundPriceForChain(price, chain) {
  if (TWO_DECIMAL_CHAINS.includes(chain)) {
    return Math.round(price * 100) / 100;
  }
  return price;
}

async function getCollectionSlug(chainName, contractAddress, apiKey) {
  const res = await fetch(`https://api.opensea.io/api/v2/chain/${chainName}/contract/${contractAddress}`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  const data = await res.json();
  return data.collection;
}

async function getFloorPrice(readOnlySdk, slug) {
  const stats = await readOnlySdk.api.getCollectionStats(slug);
  return stats.total.floorPrice;
}

async function getOwnedTokenIds(sdk, accountAddress, contractAddress, limit = 50) {
  const result = await sdk.api.getNFTsByAccount(accountAddress, limit);
  return result.nfts
    .filter((nft) => nft.contract.toLowerCase() === contractAddress.toLowerCase())
    .map((nft) => nft.identifier);
}

async function getOpenListings(sdk, walletAddress, slug, contractAddress, chain) {
  const response = await sdk.api.accounts.getProfileListings(walletAddress, { collectionSlugs: [slug] });
  return response.listings
    .filter((listing) => listing.status === 'ACTIVE' && listing.asset && listing.asset.contract.toLowerCase() === contractAddress.toLowerCase())
    .map((listing) => ({
      orderHash: listing.orderHash,
      protocolAddress: listing.protocolAddress || getSeaportAddress(chain),
      tokenId: listing.asset.identifier,
      priceValue: listing.price.current.value,
      priceDecimals: listing.price.current.decimals,
      priceCurrency: listing.price.current.currency,
      priceDisplay: Number(listing.price.current.value) / 10 ** listing.price.current.decimals,
    }));
}

async function estimateApprovalGas(wallet, contractAddress, provider, chain) {
  const conduitAddress = getDefaultConduit(chain).address;
  const contract = new ethers.Contract(contractAddress, ERC721_ABI, wallet);
  const alreadyApproved = await contract.isApprovedForAll(wallet.address, conduitAddress);

  if (alreadyApproved) {
    return { needed: false, costEth: 0 };
  }

  const gasEstimate = await contract.setApprovalForAll.estimateGas(conduitAddress, true);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  const costWei = gasEstimate * gasPrice;

  return { needed: true, costEth: parseFloat(ethers.formatEther(costWei)) };
}

async function checkStillOwned(contractAddress, tokenId, expectedOwner, provider) {
  const contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
  try {
    const currentOwner = await contract.ownerOf(tokenId);
    return currentOwner.toLowerCase() === expectedOwner.toLowerCase();
  } catch (err) {
    return false;
  }
}

module.exports = {
  CHAIN_MAP,
  Chain,
  makeSdk,
  parsePriceInput,
  roundPriceForChain,
  getCollectionSlug,
  getFloorPrice,
  getOwnedTokenIds,
  getOpenListings,
  estimateApprovalGas,
  checkStillOwned,
};

