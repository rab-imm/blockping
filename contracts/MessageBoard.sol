// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MessageBoard {
    string public message;
    address public owner;

    event MessageUpdated(address indexed sender, string newMessage);

    constructor(string memory initialMessage) {
        message = initialMessage;
        owner = msg.sender;
        emit MessageUpdated(msg.sender, initialMessage);
    }

    /// @notice Update the on-chain message
    function updateMessage(string memory newMessage) external {
        message = newMessage;
        emit MessageUpdated(msg.sender, newMessage);
    }
}
