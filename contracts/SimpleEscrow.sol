// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SimpleEscrow {
    address public buyer;
    address public seller;
    address public arbiter;
    uint256 public amount;
    bool public funded;
    bool public released;
    bool public refunded;

    event Funded(address indexed buyer, uint256 amount);
    event Released(address indexed seller, uint256 amount);
    event Refunded(address indexed buyer, uint256 amount);

    constructor(address _seller, address _arbiter) {
        buyer = msg.sender;
        seller = _seller;
        arbiter = _arbiter;
    }

    /// @notice Buyer funds the escrow
    function fund() external payable {
        require(msg.sender == buyer, "Only buyer can fund");
        require(!funded, "Already funded");
        require(msg.value > 0, "Must send ETH");
        amount = msg.value;
        funded = true;
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Release funds to the seller (buyer or arbiter)
    function release() external {
        require(funded, "Not funded");
        require(!released && !refunded, "Already settled");
        require(msg.sender == buyer || msg.sender == arbiter, "Not authorized");
        released = true;
        (bool ok, ) = seller.call{value: amount}("");
        require(ok, "Transfer failed");
        emit Released(seller, amount);
    }

    /// @notice Refund funds to the buyer (seller or arbiter)
    function refund() external {
        require(funded, "Not funded");
        require(!released && !refunded, "Already settled");
        require(msg.sender == seller || msg.sender == arbiter, "Not authorized");
        refunded = true;
        (bool ok, ) = buyer.call{value: amount}("");
        require(ok, "Transfer failed");
        emit Refunded(buyer, amount);
    }
}
